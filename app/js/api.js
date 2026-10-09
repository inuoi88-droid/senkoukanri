// GAS ウェブアプリとの通信

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function callApi(cfg, action, params = {}, { timeout = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    // text/plain にするとプリフライト（CORS の事前確認）が発生せず GAS に送れる
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...params, action, token: cfg.token }),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('通信がタイムアウトしました。電波の良い場所でもう一度お試しください。', 'timeout');
    throw new ApiError(
      navigator.onLine === false
        ? 'オフラインです。ネットにつながってからもう一度お試しください。'
        : 'サーバーに接続できませんでした。ウェブアプリの URL と、デプロイ設定（アクセスできるユーザー：全員）を確認してください。',
      'network'
    );
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError('サーバーの応答を読み取れませんでした。デプロイ設定（実行ユーザー：自分、アクセス：全員）を確認してください。', 'bad_response');
  }
  if (!json || !json.ok) throw new ApiError((json && (json.message || json.error)) || 'エラーが発生しました', json && json.error);
  return json;
}
