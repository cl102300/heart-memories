import { useEffect, useState, type FormEvent } from 'react';
import { accountSettingsService, authService } from '@/services/api';

interface AccountSettingsDialogProps {
  onClose: () => void;
  onProfileSaved: (personOneName: string, personTwoName: string, firstMeetingDate: string) => void;
}

function dateInputValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function AccountSettingsDialog({ onClose, onProfileSaved }: AccountSettingsDialogProps) {
  const [personOneName, setPersonOneName] = useState('');
  const [personTwoName, setPersonTwoName] = useState('');
  const [firstMeetingDate, setFirstMeetingDate] = useState('');
  const [phoneMasked, setPhoneMasked] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [phonePassword, setPhonePassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [busySection, setBusySection] = useState<string | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [phoneMessage, setPhoneMessage] = useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void accountSettingsService.get().then((settings) => {
      if (!active) return;
      setPersonOneName(settings.personOneName);
      setPersonTwoName(settings.personTwoName);
      setFirstMeetingDate(settings.firstMeetingDate ?? '');
      setPhoneMasked(settings.phoneMasked);
    }).catch((cause) => {
      if (active) setProfileError(cause instanceof Error ? cause.message : '读取设置失败');
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const saveNames = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusySection('profile');
    setProfileError(null);
    setProfileMessage(null);
    try {
      await accountSettingsService.setProfile(personOneName, personTwoName, firstMeetingDate || null);
      onProfileSaved(personOneName.trim(), personTwoName.trim(), firstMeetingDate);
      setProfileMessage('相册信息已保存，并同步到此账号的其他设备。');
    } catch (cause) {
      setProfileError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setBusySection(null);
    }
  };

  const savePhone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusySection('phone');
    setPhoneError(null);
    setPhoneMessage(null);
    try {
      const masked = await accountSettingsService.setPhone(phone, phonePassword);
      setPhoneMasked(masked);
      setPhone('');
      setPhonePassword('');
      setPhoneMessage('手机号已绑定，可用于找回密码。');
    } catch (cause) {
      setPhoneError(cause instanceof Error ? cause.message : '手机号保存失败，请重试');
    } finally {
      setBusySection(null);
    }
  };

  const savePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordError(null);
    setPasswordMessage(null);
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    setBusySection('password');
    try {
      await authService.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage('密码已修改，当前设备仍保持登录。');
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : '密码修改失败，请重试');
    } finally {
      setBusySection(null);
    }
  };

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-dialog__header">
          <div>
            <p className="eyebrow">账户与相册</p>
            <h2 id="settings-title">信息设置</h2>
          </div>
          <button className="settings-dialog__close" type="button" onClick={onClose} aria-label="关闭设置">×</button>
        </header>

        {isLoading ? <p className="settings-loading">正在读取账号设置…</p> : (
          <div className="settings-sections">
            <section className="settings-section" aria-labelledby="settings-names-title">
              <h3 id="settings-names-title">相册显示信息</h3>
              <p className="settings-section__description">姓名会显示在相册标题中，并同步到使用此账号的设备。</p>
              <form className="settings-form" onSubmit={(event) => void saveNames(event)}>
                <label htmlFor="person-one-name">第一位姓名</label>
                <input id="person-one-name" value={personOneName} onChange={(event) => setPersonOneName(event.currentTarget.value)} maxLength={40} placeholder="可留空" disabled={busySection !== null} />
                <label htmlFor="person-two-name">第二位姓名</label>
                <input id="person-two-name" value={personTwoName} onChange={(event) => setPersonTwoName(event.currentTarget.value)} maxLength={40} placeholder="可留空" disabled={busySection !== null} />
                <label htmlFor="settings-first-meeting-date">相识日期</label>
                <input id="settings-first-meeting-date" type="date" value={firstMeetingDate} max={dateInputValue(new Date())} onChange={(event) => setFirstMeetingDate(event.currentTarget.value)} disabled={busySection !== null} />
                {profileError && <p className="settings-error" role="alert">{profileError}</p>}
                {profileMessage && <p className="settings-success" role="status">{profileMessage}</p>}
                <button className="auth-submit" type="submit" disabled={busySection !== null}>
                  {busySection === 'profile' ? '正在保存…' : '保存相册信息'}
                </button>
              </form>
            </section>

            <section className="settings-section" aria-labelledby="settings-phone-title">
              <h3 id="settings-phone-title">找回密码手机号</h3>
              <p className="settings-section__description">
                {phoneMasked ? <>当前绑定：<strong>{phoneMasked}</strong>。修改手机号需要验证当前密码。</> : '尚未绑定手机号。绑定后可在登录页通过手机号找回密码。'}
              </p>
              <form className="settings-form" onSubmit={(event) => void savePhone(event)}>
                <label htmlFor="settings-phone">{phoneMasked ? '新手机号' : '手机号'}</label>
                <input id="settings-phone" type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.currentTarget.value)} minLength={8} maxLength={20} placeholder="手机号，可带国家区号" required disabled={busySection !== null} />
                <label htmlFor="phone-current-password">当前密码</label>
                <input id="phone-current-password" type="password" autoComplete="current-password" value={phonePassword} onChange={(event) => setPhonePassword(event.currentTarget.value)} required maxLength={128} placeholder="验证账号所有权" disabled={busySection !== null} />
                {phoneError && <p className="settings-error" role="alert">{phoneError}</p>}
                {phoneMessage && <p className="settings-success" role="status">{phoneMessage}</p>}
                <button className="auth-submit" type="submit" disabled={busySection !== null}>
                  {busySection === 'phone' ? '正在保存…' : phoneMasked ? '更新绑定手机号' : '绑定手机号'}
                </button>
              </form>
            </section>

            <section className="settings-section" aria-labelledby="settings-password-title">
              <h3 id="settings-password-title">修改登录密码</h3>
              <form className="settings-form" onSubmit={(event) => void savePassword(event)}>
                <label htmlFor="current-password">当前密码</label>
                <input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.currentTarget.value)} required maxLength={128} disabled={busySection !== null} />
                <label htmlFor="new-password">新密码</label>
                <input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.currentTarget.value)} required minLength={8} maxLength={128} placeholder="至少 8 位" disabled={busySection !== null} />
                <label htmlFor="confirm-new-password">确认新密码</label>
                <input id="confirm-new-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.currentTarget.value)} required minLength={8} maxLength={128} placeholder="再次输入新密码" disabled={busySection !== null} />
                {passwordError && <p className="settings-error" role="alert">{passwordError}</p>}
                {passwordMessage && <p className="settings-success" role="status">{passwordMessage}</p>}
                <button className="auth-submit" type="submit" disabled={busySection !== null}>
                  {busySection === 'password' ? '正在修改…' : '修改密码'}
                </button>
              </form>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
