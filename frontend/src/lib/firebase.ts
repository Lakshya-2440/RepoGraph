import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type Auth
} from "firebase/auth";

type FirebaseClientConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let persistenceReady: Promise<void> | null = null;

function getFirebaseConfig(): FirebaseClientConfig | null {
  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim() ?? "",
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() ?? "",
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim() ?? "",
    appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim() ?? ""
  };

  return Object.values(config).every(Boolean) ? config : null;
}

export function isFirebaseAuthConfigured(): boolean {
  return getFirebaseConfig() !== null;
}

function getFirebaseAuth(): Auth | null {
  const config = getFirebaseConfig();
  if (!config) {
    return null;
  }

  if (!app) {
    app = initializeApp(config);
  }

  if (!auth) {
    auth = getAuth(app);
    persistenceReady = setPersistence(auth, browserLocalPersistence);
  }

  return auth;
}

async function waitForInitialUser(firebaseAuth: Auth): Promise<string | null> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
      unsubscribe();
      resolve(user ? await user.getIdToken() : null);
    });
  });
}

export async function getCurrentFirebaseIdToken(): Promise<string | null> {
  const firebaseAuth = getFirebaseAuth();
  if (!firebaseAuth) {
    return null;
  }

  await persistenceReady;
  if (firebaseAuth.currentUser) {
    return firebaseAuth.currentUser.getIdToken();
  }

  return waitForInitialUser(firebaseAuth);
}

export async function signInWithGoogleFirebase(): Promise<string> {
  const firebaseAuth = getFirebaseAuth();
  if (!firebaseAuth) {
    throw new Error("Firebase Google sign-in is not configured.");
  }

  await persistenceReady;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const credential = await signInWithPopup(firebaseAuth, provider);
  return credential.user.getIdToken();
}

export async function signOutFromFirebase(): Promise<void> {
  const firebaseAuth = getFirebaseAuth();
  if (!firebaseAuth) {
    return;
  }

  await signOut(firebaseAuth);
}
