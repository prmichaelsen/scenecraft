import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { initializeFirebase, onAuthChange, getIdToken } from '@/lib/firebase-client'

/** Core authenticated user shape exposed via context */
export interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  emailVerified: boolean
  isAnonymous: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
}

const AuthContext = createContext<AuthContextValue>({ user: null, loading: true })

export function AuthProvider({
  children,
  initialUser,
}: {
  children: ReactNode
  initialUser?: AuthUser | null
}) {
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null)
  const [loading, setLoading] = useState(!initialUser)

  useEffect(() => {
    initializeFirebase()

    const unsubscribe = onAuthChange(async (firebaseUser) => {
      if (firebaseUser) {
        // Exchange ID token for session cookie
        const idToken = await getIdToken()
        if (idToken) {
          try {
            await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ idToken }),
            })
          } catch {
            // Non-critical — session cookie creation failed
          }
        }

        setUser({
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName,
          photoURL: firebaseUser.photoURL,
          emailVerified: firebaseUser.emailVerified,
          isAnonymous: firebaseUser.isAnonymous,
        })
      } else {
        setUser(null)
      }
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
