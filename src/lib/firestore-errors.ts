import { auth } from './local-db';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

export function getFriendlyErrorMessage(error: any): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as any).code;

  if (code === 'resource-exhausted' || message.includes('Quota') || message.includes('429')) {
    return 'Firestore 免費額度已用盡 (每日 50k 讀取)。系統已自動切換至本地模式，重置時間為下午 3:00。';
  }
  
  if (code === 'unavailable' || message.includes('offline') || message.includes('network')) {
    return '目前處於離線狀態或網路不穩定。資料將暫存於本地，並在連線後嘗試同步。';
  }

  if (code === 'permission-denied') {
    return '權限不足，無法執行此操作。請確認是否已登入或資料權限設定。';
  }

  if (code === 'deadline-exceeded') {
    return '連線逾時，請求執行時間過長。請檢查網路狀態後重試。';
  }

  return `發生未預期的資料庫錯誤 (${code || 'Unknown'})。請稍後再試。`;
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as any).code;
  
  const isQuota = code === 'resource-exhausted' || message.includes('Quota') || message.includes('429');
  const isOffline = code === 'unavailable' || message.includes('offline') || message.includes('network') || message.includes('Failed to fetch');

  const errInfo: FirestoreErrorInfo = {
    error: message,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  
  if (isQuota) {
      console.warn("Firestore Quota Exceeded [Non-Fatal]:", getFriendlyErrorMessage(error), JSON.stringify(errInfo));
  } else if (isOffline) {
      console.warn("Firestore Offline [Non-Fatal]:", getFriendlyErrorMessage(error), JSON.stringify(errInfo));
  } else {
      console.error('Firestore Fatal Error:', JSON.stringify(errInfo));
      // 對於嚴重錯誤才拋出異常，讓 UI 層級的 Error Boundary 或 Try-Catch 捕獲
      throw new Error(JSON.stringify({
        ...errInfo,
        friendlyMessage: getFriendlyErrorMessage(error)
      }));
  }
}
