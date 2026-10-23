export interface User {
  id: string;
  username: string;
}

export interface AccountSettings {
  firstMeetingDate: string | null;
  personOneName: string;
  personTwoName: string;
  phoneMasked: string | null;
}

export const accountSettingsService = {
  async get(): Promise<AccountSettings> {
    return apiRequest<AccountSettings>('/api/account-settings');
  },

  async setFirstMeetingDate(firstMeetingDate: string | null): Promise<void> {
    await apiRequest('/api/account-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMeetingDate }),
    });
  },

  async setProfile(personOneName: string, personTwoName: string, firstMeetingDate: string | null): Promise<void> {
    await apiRequest('/api/account-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personOneName, personTwoName, firstMeetingDate }),
    });
  },

  async setPhone(phone: string, currentPassword: string): Promise<string> {
    const result = await apiRequest<{ phoneMasked: string }>('/api/account-settings/phone', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, currentPassword }),
    });
    return result.phoneMasked;
  },
};

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...options });
  } catch {
    throw new Error('无法连接相册服务器，请检查网络或服务器状态');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败，请稍后重试');
  return body as T;
}

export const authService = {
  async currentUser(): Promise<User | null> {
    const result = await apiRequest<{ user: User | null }>('/api/auth/me');
    return result.user;
  },

  async login(username: string, password: string): Promise<User> {
    const result = await apiRequest<{ user: User }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return result.user;
  },

  async register(username: string, phone: string, password: string): Promise<User> {
    const result = await apiRequest<{ user: User }>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, phone, password }),
    });
    return result.user;
  },

  async getRecoveryPhone(username: string): Promise<string> {
    const result = await apiRequest<{ phoneMasked: string }>('/api/auth/recovery-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    return result.phoneMasked;
  },

  async resetPassword(username: string, phone: string, password: string): Promise<void> {
    await apiRequest('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, phone, password }),
    });
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await apiRequest('/api/auth/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  async logout(): Promise<void> {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  },
};
