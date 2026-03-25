import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { signIn, signUp, getIdToken, resetPassword } from '@/lib/firebase-client'

interface AuthFormProps {
  onSuccess?: (redirectUrl?: string) => void
  onClose?: () => void
  mode?: 'login' | 'signup' | 'forgot' | 'reset'
  resetToken?: string
  resetEmail?: string
}

const FIREBASE_ERROR_MAP: Record<string, string> = {
  'auth/user-not-found': 'No account found with this email.',
  'auth/wrong-password': 'Incorrect password. Try again.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts. Please try again later.',
  'auth/invalid-credential': 'Invalid email or password.',
  'auth/network-request-failed': 'Network error. Please check your connection.',
}

async function loginWithToken(idToken: string) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })
  if (!res.ok) throw new Error('Session creation failed')
}

export function AuthForm({
  onSuccess,
  onClose,
  mode: initialMode = 'login',
  resetToken,
  resetEmail,
}: AuthFormProps) {
  const [isLogin, setIsLogin] = useState(initialMode === 'login')
  const [isForgot, setIsForgot] = useState(initialMode === 'forgot')
  const [isReset, setIsReset] = useState(initialMode === 'reset')
  const [email, setEmail] = useState(resetEmail || '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [forgotSent, setForgotSent] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (isForgot) {
        await resetPassword(email)
        setForgotSent(true)
        setLoading(false)
        return
      } else if (isReset) {
        // Reset password with token — handled via Firebase's built-in action URL
        // This mode is shown when user arrives from a Firebase reset email
        onSuccess?.()
      } else if (isLogin) {
        await signIn(email, password)
        const idToken = await getIdToken()
        if (idToken) {
          await loginWithToken(idToken)
        }
        onSuccess?.('{{AUTH_REDIRECT}}')
      } else {
        // Signup
        if (password !== confirmPassword) {
          setError('Passwords do not match.')
          setLoading(false)
          return
        }
        await signUp(email, password)
        const idToken = await getIdToken()
        if (idToken) {
          await loginWithToken(idToken)
        }
        onSuccess?.('{{AUTH_REDIRECT}}')
      }
    } catch (err: any) {
      const code = err?.code || ''
      setError(FIREBASE_ERROR_MAP[code] || err?.message || 'An unexpected error occurred.')
    } finally {
      setLoading(false)
    }
  }

  const toggleMode = () => {
    setIsLogin(!isLogin)
    setIsForgot(false)
    setIsReset(false)
    setError(null)
    setPassword('')
    setConfirmPassword('')
  }

  const goToForgot = () => {
    setIsForgot(true)
    setIsReset(false)
    setError(null)
    setPassword('')
    setConfirmPassword('')
    setForgotSent(false)
  }

  const backToLogin = () => {
    setIsForgot(false)
    setIsReset(false)
    setIsLogin(true)
    setError(null)
    setPassword('')
    setForgotSent(false)
  }

  // Forgot password: sent confirmation
  if (isForgot && forgotSent) {
    return (
      <div className="space-y-4 text-center">
        <div className="text-success-600 bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="font-medium text-green-800">Reset link sent!</p>
          <p className="text-sm text-green-700 mt-1">
            Check your email for a password reset link.
          </p>
        </div>
        <button
          type="button"
          onClick={backToLogin}
          className="text-sm text-primary hover:text-bridge transition-colors"
        >
          Back to Sign In
        </button>
      </div>
    )
  }

  // Determine labels
  let submitLabel = 'Sign In'
  let loadingLabel = 'Signing in...'
  if (isForgot) {
    submitLabel = 'Send Reset Link'
    loadingLabel = 'Sending...'
  } else if (isReset) {
    submitLabel = 'Reset Password'
    loadingLabel = 'Resetting...'
  } else if (!isLogin) {
    submitLabel = 'Create Account'
    loadingLabel = 'Creating account...'
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Email */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isReset && !!resetEmail}
          className="w-full px-3 py-2 bg-bg-page border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:bg-bg-elevated disabled:text-text-muted disabled:cursor-not-allowed"
          placeholder="you@example.com"
          required
        />
      </div>

      {/* Password (not shown in forgot mode) */}
      {!isForgot && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-text-secondary">
              {isReset ? 'New Password' : 'Password'}
            </label>
            {isLogin && !isReset && (
              <button
                type="button"
                onClick={goToForgot}
                className="text-xs text-primary hover:text-bridge transition-colors"
              >
                Forgot Password?
              </button>
            )}
          </div>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 pr-10 bg-bg-page border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
              placeholder="Enter your password"
              minLength={6}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Confirm Password (signup and reset only) */}
      {(!isLogin || isReset) && !isForgot && (
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">
            Confirm Password
          </label>
          <input
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full px-3 py-2 bg-bg-page border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
            placeholder="Confirm your password"
            minLength={6}
            required
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-danger text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={loading}
        className="w-full py-2.5 bg-primary hover:bg-primary/90 text-white disabled:opacity-50 rounded-lg font-medium transition-colors"
      >
        {loading ? loadingLabel : submitLabel}
      </button>

      {/* Mode toggle / back link */}
      {isForgot ? (
        <p className="text-center text-sm text-text-muted">
          <button
            type="button"
            onClick={backToLogin}
            className="text-primary hover:text-bridge transition-colors"
          >
            Back to Sign In
          </button>
        </p>
      ) : !isReset ? (
        <p className="text-center text-sm text-text-muted">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            onClick={toggleMode}
            className="text-primary hover:text-bridge transition-colors font-medium"
          >
            {isLogin ? 'Sign Up' : 'Sign In'}
          </button>
        </p>
      ) : null}
    </form>
  )
}
