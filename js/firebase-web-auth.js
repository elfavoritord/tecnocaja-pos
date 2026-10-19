import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
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

// Mensajes de Firebase Auth en español (los códigos cambian entre versiones).
function mensajeDeError(error) {
  const code = String(error?.code || '');
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials'].includes(code)) {
    return 'Correo o contraseña incorrectos.';
  }
  if (code === 'auth/invalid-email') return 'El correo no es válido.';
  if (code === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e intenta de nuevo.';
  if (code === 'auth/network-request-failed') return 'Sin conexión a Internet.';
  if (code === 'auth/user-disabled') return 'Esa cuenta está desactivada.';
  return error?.message || 'No se pudo iniciar sesión.';
}

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
  // Cuenta de Tecno Caja del dueño (la misma de la app de reportes): la usa
  // el asistente para conectar una PC nueva como sucursal de su empresa.
  async signInWithEmail(email, password) {
    try {
      const result = await signInWithEmailAndPassword(auth, String(email || '').trim(), String(password || ''));
      const idToken = await result.user.getIdToken(true);
      return { idToken, email: result.user.email || '', name: result.user.displayName || '' };
    } catch (error) {
      throw new Error(mensajeDeError(error));
    }
  },
  async signOut() {
    await signOut(auth);
  }
};
