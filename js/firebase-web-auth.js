import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBLWv3KZeNBtAr9eo3totVfZtp0Mz_Ha2k',
  appId: '1:1052855422372:web:5d1ceec228f279d9b50531',
  messagingSenderId: '1052855422372',
  projectId: 'reporte-sistema-pos',
  authDomain: 'reporte-sistema-pos.firebaseapp.com',
  storageBucket: 'reporte-sistema-pos.firebasestorage.app',
  measurementId: 'G-W2KLJPVW5N'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

window.firebaseWebAuth = {
  async signInWithGoogle(languageCode = 'es') {
    auth.languageCode = languageCode || 'es';
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    const idToken = await result.user.getIdToken(true);
    return {
      idToken,
      email: result.user.email || '',
      name: result.user.displayName || ''
    };
  },
  async signOut() {
    await signOut(auth);
  }
};
