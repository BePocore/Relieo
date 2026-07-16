// Config web Firebase (valeurs publiques côté client) SANS importer le SDK.
// Séparée de firebase.ts pour que la consultation publique puisse savoir si
// Firebase est configuré (firebaseEnabled) sans télécharger les ~110 Ko gzip
// du SDK, qui ne sert qu'au portail et aux écritures du Studio.
const cleanEnv = (value: string | undefined): string | undefined => {
  const cleaned = value?.replace(/^\uFEFF/, '').trim()
  return cleaned || undefined
}

// Le nettoyage du BOM protège notamment les valeurs collées ou importées dans
// Vercel.
export const firebaseWebConfig = {
  apiKey: cleanEnv(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: cleanEnv(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: cleanEnv(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  appId: cleanEnv(import.meta.env.VITE_FIREBASE_APP_ID),
}

// Firebase est obligatoire pour le portail et le Studio authentifié.
export const firebaseEnabled = Boolean(
  firebaseWebConfig.apiKey &&
    firebaseWebConfig.authDomain &&
    firebaseWebConfig.projectId &&
    firebaseWebConfig.appId,
)
