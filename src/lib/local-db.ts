import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'cuibo-accounting-local';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<any>> | null = null;
const listeners = new Map<string, Set<Function>>();

function initDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('paymentAccounts')) db.createObjectStore('paymentAccounts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('taxRefunds')) db.createObjectStore('taxRefunds', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('transfers')) db.createObjectStore('transfers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

const notify = (collectionName: string) => {
  if (listeners.has(collectionName)) {
    listeners.get(collectionName)?.forEach(fn => fn());
  }
};

export const collection = (dbInstance: any, path: string) => {
  const parts = path.split('/');
  return { path, collectionName: parts[parts.length - 1] };
};

export const doc = (collectionOrDb: any, ...pathSegments: string[]) => {
  let fullPath = '';
  if (typeof collectionOrDb === 'string') {
      fullPath = collectionOrDb;
  } else if (collectionOrDb && collectionOrDb.collectionName && pathSegments.length === 0) {
      fullPath = `${collectionOrDb.path}/${generateId()}`;
  } else if (collectionOrDb && collectionOrDb.collectionName && pathSegments.length === 1) {
      fullPath = `${collectionOrDb.path}/${pathSegments[0]}`;
  } else if (pathSegments.length > 0) {
      fullPath = pathSegments.join('/');
  }
  const parts = fullPath.split('/');
  return { path: fullPath, collectionName: parts[parts.length - 2], id: parts[parts.length - 1] };
};

const generateId = () => Math.random().toString(36).substr(2, 9);

export const getDoc = async (docRef: any) => {
  const db = await initDB();
  const data = await db.get(docRef.collectionName, docRef.id);
  return {
    id: docRef.id,
    exists: () => !!data,
    data: () => data
  };
};

export const getDocFromCache = getDoc;

export const setDoc = async (docRef: any, data: any) => {
  const db = await initDB();
  const parentPath = docRef.path.split('/').slice(0, -1).join('/');
  await db.put(docRef.collectionName, { id: docRef.id, _collectionPath: parentPath, ...data });
  notify(docRef.collectionName);
};

export const updateDoc = async (docRef: any, data: any) => {
  const db = await initDB();
  const existing = await db.get(docRef.collectionName, docRef.id);
  if (existing) {
    let merged = { ...existing };
    for (const key of Object.keys(data)) {
        if (typeof data[key] === 'object' && data[key]?._isIncrement) {
             merged[key] = (merged[key] || 0) + data[key].value;
        } else {
             merged[key] = data[key];
        }
    }
    const parentPath = docRef.path.split('/').slice(0, -1).join('/');
    merged._collectionPath = parentPath;
    await db.put(docRef.collectionName, merged);
    notify(docRef.collectionName);
  }
};

export const deleteDoc = async (docRef: any) => {
  const db = await initDB();
  await db.delete(docRef.collectionName, docRef.id);
  notify(docRef.collectionName);
};

export const increment = (amount: number) => {
  return { _isIncrement: true, value: amount };
};

export const getDocs = async (queryRef: any) => {
  const db = await initDB();
  const collectionName = queryRef.collectionName;
  let all = await db.getAll(collectionName);
  all = all.filter(item => item !== undefined && item !== null);
  
  // Filter by subcollection path if it's a subcollection
  if (queryRef.path) {
     all = all.filter(item => item._collectionPath === queryRef.path);
  }

  if (queryRef.orderByList && queryRef.orderByList.length > 0) {

     for (const order of queryRef.orderByList.reverse()) {
         all.sort((a, b) => {
              const valA = a[order.field] || '';
              const valB = b[order.field] || '';
              if (valA === valB) return 0;
              if (order.direction === 'desc') return valA < valB ? 1 : -1;
              return valA > valB ? 1 : -1;
         });
     }
  }

  // Handle where filters
  if (queryRef.whereList && queryRef.whereList.length > 0) {
      for (const filter of queryRef.whereList) {
          all = all.filter(item => {
              const itemVal = item[filter.field];
              if (filter.operator === '>') return itemVal > filter.value;
              if (filter.operator === '<') return itemVal < filter.value;
              if (filter.operator === '==') return itemVal === filter.value;
              return true; // For unhandled operators fallback to unfiltered
          });
      }
  }

  return {
    docs: all.map(data => ({
      id: data.id,
      data: () => data
    }))
  };
};

export const getDocsFromCache = getDocs;

export const query = (collectionRef: any, ...args: any[]) => {
  const q = { ...collectionRef, orderByList: [], whereList: [] };
  args.forEach(arg => {
    if (arg._isOrderBy) {
        q.orderByList.push(arg);
    } else if (arg._isWhere) {
        q.whereList.push(arg);
    }
  });
  return q;
};

export const orderBy = (field: string, direction: 'asc'|'desc' = 'asc') => {
  return { _isOrderBy: true, field, direction };
};

export const where = (field: string, operator: string, value: any) => {
  return { _isWhere: true, field, operator, value };
};

export const onSnapshot = (queryRef: any, callback: Function) => {
  const fetchAndCall = async () => {
    const snap = await getDocs(queryRef);
    callback(snap);
  };
  fetchAndCall();
  
  if (!listeners.has(queryRef.collectionName)) {
    listeners.set(queryRef.collectionName, new Set());
  }
  listeners.get(queryRef.collectionName)?.add(fetchAndCall);
  
  return () => {
    listeners.get(queryRef.collectionName)?.delete(fetchAndCall);
  };
};

// Export DB mock for local
export const db = {};

// Auth Mock
const LOCAL_USER = {
  uid: 'local_user_id',
  email: 'user@local.domain',
  displayName: 'Local User',
  photoURL: 'https://ui-avatars.com/api/?name=Local+User'
};

export const signInWithPopup = async () => {
   // No-op
};
export const signOut = async () => {
   // No-op
};
export const onAuthStateChanged = (authObj: any, cb: Function) => {
   cb(LOCAL_USER);
   return () => {};
};
export const GoogleAuthProvider = class {};
export const auth: any = { currentUser: LOCAL_USER };

export const setOnlineStatus = (online: boolean) => {};
export const getSyncMode = () => 'auto';

// Simple Backup Functionality
export const exportData = async () => {
    const database = await initDB();
    const data: any = {};
    const stores = ['paymentAccounts', 'receipts', 'taxRefunds', 'transfers'];
    for (const store of stores) {
        data[store] = await database.getAll(store);
    }
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cuibo-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

export const importData = async (file: File) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const content = e.target?.result as string;
                const data = JSON.parse(content);
                const database = await initDB();
                
                const stores = ['paymentAccounts', 'receipts', 'taxRefunds', 'transfers'];
                for (const store of stores) {
                    if (data[store] && Array.isArray(data[store])) {
                        const tx = database.transaction(store, 'readwrite');
                        // clear existing?
                        await tx.objectStore(store).clear();
                        for (const item of data[store]) {
                           await tx.objectStore(store).put(item);
                        }
                        await tx.done;
                        notify(store);
                    }
                }
                resolve(true);
            } catch (error) {
                reject(error);
            }
        };
        reader.readAsText(file);
    });
};
