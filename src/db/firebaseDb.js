/**
 * Firebase Firestore & Realtime DB adapter
 * 
 * Digunakan saat dideploy di Vercel atau saat env FIREBASE_* tersedia.
 */

const admin = require('firebase-admin');

let isInitialized = false;
let db = null;

function initFirebase() {
  if (isInitialized) return db;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    return null; // Firebase credentials not set
  }

  // Handle newline escapes in private key
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey
        })
      });
    }

    db = admin.firestore();
    isInitialized = true;
    console.log('[Firebase] Connected to Firestore successfully');
    return db;
  } catch (err) {
    console.error('[Firebase] Init error:', err.message);
    return null;
  }
}

module.exports = {
  initFirebase,
  getFirestore: initFirebase
};
