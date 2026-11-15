/* Web FCM notifications: config in this file must be set to the NEW public Firebase project.
 * This Service Worker receives notifications, but an authenticated server must send them.
 * Do not copy any private project config here.
 */
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js');
const firebaseConfig={
  "apiKey": "AIzaSyD3izLdDivO3X3pfkVRjFpvalOpQdyw92U",
  "authDomain": "nogoom-al-beet-p.firebaseapp.com",
  "projectId": "nogoom-al-beet-p",
  "storageBucket": "nogoom-al-beet-p.firebasestorage.app",
  "messagingSenderId": "906041789857",
  "appId": "1:906041789857:web:d769c0532a48c8bdf64fe0",
  "measurementId": "G-CWQQ31M560"
};
if(firebaseConfig.apiKey){
 firebase.initializeApp(firebaseConfig);
 const messaging=firebase.messaging();
 messaging.onBackgroundMessage(payload=>{
  const title=payload.data?.title||'نجوم البيت';
  const body=payload.data?.body||'لديك إشعار جديد';
  self.registration.showNotification(title,{body,icon:'./icons/icon-192.png',badge:'./icons/icon-192.png',tag:'nogoom-'+Date.now(),data:{url:'./'}});
 });
}
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(clients.openWindow('./'))});
