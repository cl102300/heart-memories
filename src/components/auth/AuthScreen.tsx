import { useState, type FormEvent } from 'react';
import { authService, type User } from '@/services/api';

interface AuthScreenProps {
  onAuthenticated: (user: User) => void;
  isChecking?: boolean;
  initialError?: string | null;
}

type AuthMode = 'login' | 'register' | 'recovery';

export function AuthScreen({ onAuthenticated, isChecking = false, initialError = null }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryPhoneMasked, setRecoveryPhoneMasked] = useState<string | null>(null);
  const [recoveryUsername, setRecoveryUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const resetRecovery = () => {
    setRecoveryPhoneMasked(null);
    setRecoveryUsername('');
    setPhone('');
    setPassword('');
    setConfirmPassword('');
  };

  const handleLookupPhone = async () => {
    const account = username.trim();
    if (!account) {
      setError('请先输入账号');
      return;
    }
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const masked = await authService.getRecoveryPhone(account);
      setRecoveryUsername(account);
      setRecoveryPhoneMasked(masked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '查询失败，请重试');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    try {
      if (mode === 'recovery') {
        if (!recoveryPhoneMasked || recoveryUsername !== username.trim()) {
          throw new Error('请先查询该账号绑定的手机号');
        }
        if (password !== confirmPassword) throw new Error('两次输入的新密码不一致');
        await authService.resetPassword(recoveryUsername, phone, password);
        resetRecovery();
        setMode('login');
        setSuccess('密码已修改，请使用新密码登录');
        return;
      }

      const user = mode === 'register'
        ? await authService.register(username, phone, password)
        : await authService.login(username, password);
      setPassword('');
      onAuthenticated(user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setIsLoading(false);
    }
  };

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setSuccess(null);
    resetRecovery();
  };

  const title = isChecking
    ? '正在连接相册'
    : mode === 'register'
      ? '创建相册账户'
      : mode === 'recovery'
        ? '手机号找回密码'
        : '登录回忆相册';

  return (
    <div className="app-shell auth-shell">
      <div className="ambient-light ambient-light--rose" aria-hidden="true" />
      <div className="ambient-light ambient-light--gold" aria-hidden="true" />
      <main className="auth-page">
        <a className="brand auth-brand" href="#top" aria-label="Heart Memories">
          <span className="brand__mark" aria-hidden="true">♥</span>
          <span className="brand__copy">
            <strong>HEART MEMORIES</strong>
            <small>珍藏我们俩的每一个瞬间</small>
          </span>
        </a>

        <section className="auth-card" aria-labelledby="auth-title">
          <p className="eyebrow">我们的私人相册</p>
          <h1 id="auth-title">{title}</h1>
          <p className="auth-card__description">
            {isChecking
              ? '正在确认登录状态…'
              : mode === 'recovery'
                ? '输入账号查询绑定手机号，再填写完整号码和新密码。'
                : '登录同一账户，即可在不同手机上共享照片。'}
          </p>

          {!isChecking && (
            <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
              <label htmlFor="auth-username">账号</label>
              <input
                id="auth-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                value={username}
                onChange={(event) => {
                  setUsername(event.currentTarget.value);
                  if (mode === 'recovery') {
                    setRecoveryPhoneMasked(null);
                    setRecoveryUsername('');
                    setPhone('');
                  }
                }}
                placeholder="输入账号"
                required
                minLength={3}
                maxLength={64}
                disabled={isLoading}
              />

              {mode === 'register' && (
                <>
                  <label htmlFor="auth-phone">手机号</label>
                  <input
                    id="auth-phone"
                    name="tel"
                    type="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.currentTarget.value)}
                    placeholder="手机号，可带国家区号"
                    required
                    minLength={8}
                    maxLength={20}
                    disabled={isLoading}
                  />
                </>
              )}

              {mode === 'recovery' && (
                <>
                  <button className="auth-submit auth-submit--secondary" type="button" onClick={() => void handleLookupPhone()} disabled={isLoading}>
                    {isLoading ? '正在查询…' : '查询绑定手机号'}
                  </button>
                  {recoveryPhoneMasked && recoveryUsername === username.trim() && (
                    <>
                      <p className="auth-recovery-phone">绑定手机号：<strong>{recoveryPhoneMasked}</strong></p>
                      <label htmlFor="recovery-phone">完整手机号</label>
                      <input
                        id="recovery-phone"
                        name="tel"
                        type="tel"
                        autoComplete="tel"
                        value={phone}
                        onChange={(event) => setPhone(event.currentTarget.value)}
                        placeholder="输入完整绑定手机号"
                        required
                        minLength={8}
                        maxLength={20}
                        disabled={isLoading}
                      />
                      <label htmlFor="recovery-password">新密码</label>
                      <input
                        id="recovery-password"
                        name="new-password"
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(event) => setPassword(event.currentTarget.value)}
                        placeholder="至少 8 位"
                        required
                        minLength={8}
                        maxLength={128}
                        disabled={isLoading}
                      />
                      <label htmlFor="recovery-confirm-password">确认新密码</label>
                      <input
                        id="recovery-confirm-password"
                        name="confirm-password"
                        type="password"
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                        placeholder="再次输入新密码"
                        required
                        minLength={8}
                        maxLength={128}
                        disabled={isLoading}
                      />
                    </>
                  )}
                </>
              )}

              {mode !== 'recovery' && (
                <>
                  <label htmlFor="auth-password">密码</label>
                  <input
                    id="auth-password"
                    name="password"
                    type="password"
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                    placeholder={mode === 'register' ? '至少 8 位' : '输入密码'}
                    required
                    minLength={mode === 'register' ? 8 : undefined}
                    maxLength={128}
                    disabled={isLoading}
                  />
                </>
              )}

              {(error || initialError) && <p className="auth-error" role="alert">{error || initialError}</p>}
              {success && <p className="auth-success" role="status">{success}</p>}

              {mode !== 'recovery' || recoveryPhoneMasked ? (
                <button className="auth-submit" type="submit" disabled={isLoading}>
                  {isLoading ? '请稍候…' : mode === 'register' ? '创建账户并进入' : mode === 'recovery' ? '确认并修改密码' : '登录相册'}
                </button>
              ) : null}
            </form>
          )}

          {!isChecking && (
            <div className="auth-links">
              {mode === 'login' && (
                <>
                  <button className="auth-switch" type="button" onClick={() => changeMode('recovery')} disabled={isLoading}>
                    忘记密码？手机号找回
                  </button>
                  <button className="auth-switch" type="button" onClick={() => changeMode('register')} disabled={isLoading}>
                    第一次使用？创建账户
                  </button>
                </>
              )}
              {mode === 'register' && (
                <button className="auth-switch" type="button" onClick={() => changeMode('login')} disabled={isLoading}>
                  已有账户？返回登录
                </button>
              )}
              {mode === 'recovery' && (
                <button className="auth-switch" type="button" onClick={() => changeMode('login')} disabled={isLoading}>
                  返回登录
                </button>
              )}
            </div>
          )}
          <p className="auth-card__footnote">照片会保存到相册服务器的 SQLite 数据库中。</p>
        </section>
      </main>
    </div>
  );
}
