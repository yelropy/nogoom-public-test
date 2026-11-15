/* Requires a separate production Firebase project, billing-enabled Cloud Functions,
   verified rules, privacy review, and testing before deployment. */
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {onDocumentCreated}=require('firebase-functions/v2/firestore');
const admin=require('firebase-admin');
const crypto=require('node:crypto');
admin.initializeApp();
const db=admin.firestore();
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const getMembership=async(fid,uid)=>{const x=await db.doc(`families/${fid}/members/${uid}`).get();return x.exists?x.data():null};
exports.createInvite=onCall({region:'europe-west1',enforceAppCheck:true},async request=>{
 const uid=request.auth?.uid,{familyId,role,childId}=request.data||{};
 if(!uid)throw new HttpsError('unauthenticated','Sign in first');
 if(typeof familyId!=='string'||!['mother','child'].includes(role))throw new HttpsError('invalid-argument','Invalid invitation');
 const member=await getMembership(familyId,uid);
 if(!member||!['father','mother'].includes(member.role))throw new HttpsError('permission-denied','Parents only');
 if(role==='child'){
  if(typeof childId!=='string'||!(await db.doc(`families/${familyId}/children/${childId}`).get()).exists)
   throw new HttpsError('invalid-argument','Child profile missing');
 }
 const token=crypto.randomBytes(24).toString('base64url');
 await db.doc(`invites/${hash(token)}`).set({familyId,role,childId:role==='child'?childId:null,createdBy:uid,expiresAt:admin.firestore.Timestamp.fromMillis(Date.now()+24*60*60*1000),used:false});
 return {inviteCode:token,expiresInHours:24};
});
exports.redeemInvite=onCall({region:'europe-west1',enforceAppCheck:true},async request=>{
 const uid=request.auth?.uid,token=request.data?.inviteCode;
 if(!uid)throw new HttpsError('unauthenticated','Sign in first');
 if(typeof token!=='string'||token.length>100)throw new HttpsError('invalid-argument','Invalid code');
 const inviteRef=db.doc(`invites/${hash(token)}`),userRef=db.doc(`users/${uid}`);
 return db.runTransaction(async tx=>{
  const [invite,user]=await Promise.all([tx.get(inviteRef),tx.get(userRef)]);
  if(user.exists)throw new HttpsError('already-exists','This account belongs to a family');
  if(!invite.exists||invite.data().used||invite.data().expiresAt.toMillis()<Date.now())throw new HttpsError('permission-denied','Expired or invalid invitation');
  const {familyId,role,childId}=invite.data();
  const memberRef=db.doc(`families/${familyId}/members/${uid}`);
  tx.set(memberRef,{uid,role,childId:childId||null,name:request.auth.token.email||'New member',createdAt:admin.firestore.FieldValue.serverTimestamp()});
  tx.set(userRef,{familyId,role,createdAt:admin.firestore.FieldValue.serverTimestamp()});
  tx.update(inviteRef,{used:true,usedBy:uid,usedAt:admin.firestore.FieldValue.serverTimestamp()});
  return {familyId,role};
 });
});
exports.pushFamilyEvent=onDocumentCreated({document:'families/{familyId}/events/{eventId}',region:'europe-west1'},async event=>{
 const info=event.data?.data(),fid=event.params.familyId;
 if(!info||!info.actorId||!['login','task','allowance','chat'].includes(info.type))return;
 const actor=await getMembership(fid,info.actorId);if(!actor)return;
 const members=await db.collection(`families/${fid}/members`).get();
 const recipients=members.docs.filter(d=>d.id!==info.actorId&&['father','mother'].includes(d.data().role));
 const tokens=[];
 for(const m of recipients){const snap=await m.ref.collection('tokens').where('enabled','==',true).limit(20).get();for(const d of snap.docs)tokens.push(d.data().token)}
 if(!tokens.length)return;
 const title=info.type==='allowance'?'طلب مصروف جديد':'نشاط جديد في نجوم البيت';
 // Avoid sending sensitive text content from children's actions to lock screens.
 const body=info.type==='login'?'دخل أحد أفراد الأسرة إلى التطبيق.':info.type==='task'?'تم تحديث أحد البنود.':'لديك تحديث عائلي جديد.';
 for(let i=0;i<tokens.length;i+=500){await admin.messaging().sendEachForMulticast({tokens:tokens.slice(i,i+500),data:{title,body},webpush:{headers:{Urgency:'normal'}}})}
});

// SECURITY-ENFORCED PRAYER REGISTRATION
// These endpoints run on Firebase servers: changing the device clock or HTML
// cannot bypass the registration window. The marks collection is read-only
// from clients in firestore.rules.
const COUNTRY_NAMES={KW:'Kuwait',EG:'Egypt',SA:'Saudi Arabia',AE:'United Arab Emirates',QA:'Qatar',BH:'Bahrain',OM:'Oman',JO:'Jordan',US:'United States',GB:'United Kingdom',DE:'Germany',FR:'France'};
const PRAYER_KEYS=['Fajr','Dhuhr','Asr','Maghrib','Isha'];
const dailyCache=new Map();
const dateInZone=(date,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date).replace(/(\d{2})\/(\d{2})\/(\d{4})/,'$3-$1-$2');
const partsInZone=(date,zone)=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
function zonedToMs(day,hm,zone){
 const [yy,mm,dd]=day.split('-').map(Number),time=hm.match(/^(\d\d):(\d\d)/);
 if(!time)throw new Error('Invalid prayer time');
 const target=Date.UTC(yy,mm-1,dd,Number(time[1]),Number(time[2]));let guess=target;
 for(let i=0;i<3;i++){
  const p=partsInZone(new Date(guess),zone),observed=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);
  guess+=target-observed;
 }
 return guess;
}
function isoDay(date,zone){const p=partsInZone(date,zone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
async function getSchedule(family){
 const country=COUNTRY_NAMES[family.country];
 if(!country||!family.city||!String(family.city).trim())throw new HttpsError('failed-precondition','حدد دولة ومدينة صحيحتين في إعدادات الأسرة');
 const method=String(family.prayerMethod||'9');
 const configKey=`${country}|${family.city}|${method}`;
 let day=new Date().toISOString().slice(0,10),payload;
 for(let attempt=0;attempt<2;attempt++){
  const key=`${configKey}|${day}`,cached=dailyCache.get(key);
  if(cached&&Date.now()-cached.loadedAt<120000){payload=cached.payload;}
  else{
   const [year,month,dd]=day.split('-'),u=new URL(`https://api.aladhan.com/v1/timingsByCity/${dd}-${month}-${year}`);
   u.searchParams.set('city',family.city);u.searchParams.set('country',country);u.searchParams.set('method',method);
   let res;
   try{res=await fetch(u,{signal:AbortSignal.timeout(8000)});}catch(e){throw new HttpsError('unavailable','تعذر الوصول إلى خدمة مواقيت الصلاة');}
   if(!res.ok)throw new HttpsError('unavailable','خدمة المواقيت غير متاحة حالياً');
   const json=await res.json();if(json.code!==200||!json.data?.meta?.timezone||!json.data?.timings)throw new HttpsError('failed-precondition','لم يمكن التحقق من مواقيت المدينة');
   payload=json.data;dailyCache.set(key,{payload,loadedAt:Date.now()});
   if(dailyCache.size>80)dailyCache.delete(dailyCache.keys().next().value);
  }
  let localDay;try{localDay=isoDay(new Date(),payload.meta.timezone)}catch(e){throw new HttpsError('failed-precondition','تعذر تحديد المنطقة الزمنية للمدينة')}
  if(localDay===day)break;
  day=localDay;
  if(attempt===1)throw new HttpsError('unavailable','تعذر ضبط تاريخ الصلاة المحلي');
 }
 const zone=payload.meta.timezone;
 const windowMinutes=Number(family.prayerWindow??30);
 if(!Number.isInteger(windowMinutes)||windowMinutes<5||windowMinutes>180)throw new HttpsError('failed-precondition','مهلة الصلاة غير صالحة');
 const windows=PRAYER_KEYS.map(key=>{
  const startMs=zonedToMs(day,payload.timings[key],zone);
  return {key,startMs,endMs:startMs+windowMinutes*60000};
 });
 return {date:day,timezone:zone,windowMinutes,windows,serverNow:Date.now()};
}
async function getPrayerContext(request){
 const uid=request.auth?.uid;if(!uid)throw new HttpsError('unauthenticated','سجّل الدخول أولاً');
 const mapping=await db.doc(`users/${uid}`).get();if(!mapping.exists)throw new HttpsError('permission-denied','الحساب غير مرتبط بأسرة');
 const fid=mapping.data().familyId,member=await getMembership(fid,uid);
 if(!member)throw new HttpsError('permission-denied','لست عضواً في هذه الأسرة');
 const doc=await db.doc(`families/${fid}`).get();if(!doc.exists)throw new HttpsError('not-found','الأسرة غير موجودة');
 return {uid,fid,member,family:doc.data()};
}
exports.getPrayerWindows=onCall({region:'europe-west1',enforceAppCheck:true},async request=>{
 const ctx=await getPrayerContext(request),schedule=await getSchedule(ctx.family);
 const snap=await db.doc(`families/${ctx.fid}/prayerDays/${schedule.date}`).get();
 const marks=snap.exists?snap.data().marks||{}:{};
 // A child only sees their own marks, while parents can see all children.
 if(ctx.member.role==='child')return {...schedule,marks:{[ctx.member.childId]:marks[ctx.member.childId]||{}}};
 return {...schedule,marks};
});
exports.markPrayer=onCall({region:'europe-west1',enforceAppCheck:true},async request=>{
 const ctx=await getPrayerContext(request),childId=request.data?.childId,prayer=request.data?.prayer;
 if(typeof childId!=='string'||childId.length>128||!PRAYER_KEYS.includes(prayer))throw new HttpsError('invalid-argument','بيانات الصلاة غير صحيحة');
 if(!['father','mother','child'].includes(ctx.member.role))throw new HttpsError('permission-denied','صلاحيات غير كافية');
 if(ctx.member.role==='child'&&ctx.member.childId!==childId)throw new HttpsError('permission-denied','لا يمكن تعديل جدول طفل آخر');
 if(!(await db.doc(`families/${ctx.fid}/children/${childId}`).get()).exists)throw new HttpsError('not-found','ملف الطفل غير موجود');
 const schedule=await getSchedule(ctx.family),win=schedule.windows.find(x=>x.key===prayer);
 if(Date.now()<win.startMs||Date.now()>=win.endMs)throw new HttpsError('failed-precondition','زر «صليت» متاح فقط في وقت الصلاة المحدد');
 const ref=db.doc(`families/${ctx.fid}/prayerDays/${schedule.date}`);
 await db.runTransaction(async tx=>{
  const snap=await tx.get(ref),marks=snap.exists?(snap.data().marks||{}):{};
  if(marks[childId]?.[prayer])throw new HttpsError('already-exists','الصلاة مسجلة بالفعل');
  // Re-check server time right before committing the transaction.
  if(Date.now()<win.startMs||Date.now()>=win.endMs)throw new HttpsError('failed-precondition','انتهت مهلة الصلاة');
  const updated={...marks,[childId]:{...(marks[childId]||{}),[prayer]:{by:ctx.uid,at:admin.firestore.Timestamp.now()}}};
  tx.set(ref,{marks:updated,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 });
 return {success:true,day:schedule.date,prayer};
});
