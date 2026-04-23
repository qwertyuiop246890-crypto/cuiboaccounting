import React, { useState, useEffect } from 'react';
import { collection, query, doc, setDoc, deleteDoc, orderBy, updateDoc, getDocs } from '../lib/local-db';
import { db, auth } from '../firebase';
import { handleFirestoreError, OperationType, getFriendlyErrorMessage } from '../lib/firestore-errors';
import { Plus, Trash2, CreditCard, ArrowUp, ArrowDown, Edit2, Check, X as CloseIcon, Download, Upload, Database } from 'lucide-react';

export function Settings() {
  const [accounts, setAccounts] = useState<any[]>([]);
  
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState('日幣現金');
  const [newAccountCurrency, setNewAccountCurrency] = useState('JPY');
  const [newAccountBalance, setNewAccountBalance] = useState('');

  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editAccountData, setEditAccountData] = useState({ name: '', type: '', currency: '', balance: '' });

  const handleExportData = async () => {
    if (!auth.currentUser) return;
    const uid = auth.currentUser.uid;
    
    let exportData: any = null;

    try {
      const data: any = {
        paymentAccounts: [],
        receipts: {},
        taxRefunds: [],
        exportedAt: new Date().toISOString(),
        version: "2.0-local"
      };

      const accountsSnap = await getDocs(collection(db, `users/${uid}/paymentAccounts`));
      data.paymentAccounts = accountsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const refundsSnap = await getDocs(collection(db, `users/${uid}/taxRefunds`));
      data.taxRefunds = refundsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const receiptsSnap = await getDocs(collection(db, `users/${uid}/receipts`));
      for (const rDoc of receiptsSnap.docs) {
        const receiptData = rDoc.data();
        const itemsSnap = await getDocs(collection(db, `users/${uid}/receipts/${rDoc.id}/items`));
        data.receipts[rDoc.id] = {
          data: receiptData,
          items: itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        };
      }
      exportData = data;
    } catch (e: any) {
      console.error("Local data export failed", e);
      alert("匯出失敗，請重試");
      return;
    }

    if (exportData) {
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cui_bo_local_backup_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
    }
  };

  const handleImportData = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !auth.currentUser) return;
    const uid = auth.currentUser.uid;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        
        // Import Payment Accounts
        if (Array.isArray(data.paymentAccounts)) {
          for (const acc of data.paymentAccounts) {
            // Keep the old ID if possible to maintain relationships
            const accDoc = doc(db, `users/${uid}/paymentAccounts/${acc.id}`);
            await setDoc(accDoc, acc);
          }
        }

        // Import Tax Refunds (if any exist)
        if (Array.isArray(data.taxRefunds)) {
          for (const ref of data.taxRefunds) {
            const refDoc = ref.id ? doc(db, `users/${uid}/taxRefunds/${ref.id}`) : doc(collection(db, `users/${uid}/taxRefunds`));
            await setDoc(refDoc, ref);
          }
        }

        // Import Receipts (supports both object dict and array versions)
        const processReceipt = async (rId: string, rData: any, items: any) => {
            const rRef = doc(db, `users/${uid}/receipts/${rId}`);
            // Normalize photoUrl just in case
            if (Array.isArray(rData.photoUrls) && rData.photoUrls.length > 0 && !rData.photoUrl) {
                rData.photoUrl = rData.photoUrls[0];
            }
            await setDoc(rRef, rData);
            
            // Handle items (could be an array from new exports, or just missing/empty array)
            if (Array.isArray(items)) {
              for (const item of items) {
                const itemRef = item.id ? doc(db, `users/${uid}/receipts/${rId}/items/${item.id}`) : doc(collection(db, `users/${uid}/receipts/${rId}/items`));
                await setDoc(itemRef, item);
              }
            } else if (typeof items === 'object' && items !== null) {
              // Extremely old format fallback where items was a dictionary
              for (const itemId in items) {
                await setDoc(doc(db, `users/${uid}/receipts/${rId}/items/${itemId}`), items[itemId]);
              }
            }
        };

        if (data.receipts && !Array.isArray(data.receipts)) {
          // It's a dictionary like your old backup: { "1yy...": { data: {...}, items: [] } }
          for (const rId in data.receipts) {
            const { data: rData, items } = data.receipts[rId];
            if (rData) {
               await processReceipt(rId, rData, items);
            }
          }
        } else if (Array.isArray(data.receipts)) {
           // Newer V2 array format just in case
           for (const rObj of data.receipts) {
               const rId = rObj.id;
               const items = rObj.items || [];
               delete rObj.items;
               await processReceipt(rId, rObj, items);
           }
        }

        alert("資料匯入成功！請重新整理頁面以查看最新資料。");
        window.location.reload();
      } catch (e) {
        console.error("Import failed", e);
        alert("資料匯入失敗");
      }
    };
    reader.readAsText(file);
  };
  const existingTypes = Array.from(new Set(accounts.map(a => a.type || '日幣現金')));
  const existingCurrencies = Array.from(new Set(accounts.map(a => a.currency || 'JPY')));

  useEffect(() => {
    if (!auth.currentUser) return;

    const fetchAccounts = async () => {
      const accountsQ = query(collection(db, `users/${auth.currentUser!.uid}/paymentAccounts`));
      try {
        const snapshot = await getDocs(accountsQ);
        const accountsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const sortedAccounts = accountsData.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
        setAccounts(sortedAccounts);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `users/${auth.currentUser?.uid}/paymentAccounts`);
      }
    };

    fetchAccounts();
    return () => {};
  }, []);

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountName.trim() || !newAccountBalance || !auth.currentUser) return;
    
    const accountRef = doc(collection(db, `users/${auth.currentUser.uid}/paymentAccounts`));
    const maxOrder = accounts.length > 0 ? Math.max(...accounts.map(a => a.order || 0)) : -1;
    
    try {
      setDoc(accountRef, {
        name: newAccountName,
        type: newAccountType,
        balance: Number(newAccountBalance),
        currency: newAccountCurrency,
        order: maxOrder + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).catch(e=>console.warn(e));
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${auth.currentUser.uid}/paymentAccounts`);
    }
    
    setNewAccountName('');
    setNewAccountBalance('');
  };

  const handleStartEdit = (account: any) => {
    setEditingAccountId(account.id);
    setEditAccountData({
      name: account.name,
      type: account.type,
      currency: account.currency,
      balance: account.balance.toString()
    });
  };

  const handleSaveEdit = async () => {
    if (!auth.currentUser || !editingAccountId) return;
    try {
      updateDoc(doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${editingAccountId}`), {
        name: editAccountData.name,
        type: editAccountData.type,
        currency: editAccountData.currency,
        balance: Number(editAccountData.balance),
        updatedAt: new Date().toISOString()
      }).catch(e=>console.warn(e));
      setEditingAccountId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${auth.currentUser.uid}/paymentAccounts/${editingAccountId}`);
    }
  };

  const handleMoveAccount = async (index: number, direction: 'up' | 'down') => {
    if (!auth.currentUser) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= accounts.length) return;

    const currentAccount = accounts[index];
    const targetAccount = accounts[targetIndex];

    try {
      const currentRef = doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${currentAccount.id}`);
      const targetRef = doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${targetAccount.id}`);

      // Swap orders
      const currentOrder = currentAccount.order ?? index;
      const targetOrder = targetAccount.order ?? targetIndex;

      updateDoc(currentRef, { order: targetOrder }).catch(e=>console.warn(e));
      updateDoc(targetRef, { order: currentOrder }).catch(e=>console.warn(e));
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${auth.currentUser.uid}/paymentAccounts`);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!auth.currentUser) return;
    try {
      deleteDoc(doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${id}`)).catch(e=>console.warn(e));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `users/${auth.currentUser.uid}/paymentAccounts/${id}`);
    }
  };

  return (
    <div className="p-4 max-w-md mx-auto space-y-8 bg-background min-h-screen">
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-serif font-bold text-ink tracking-tight">設定</h1>
      </header>

      {/* Data Backup */}
      <section className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider">
        <h2 className="text-lg font-serif font-bold text-ink flex items-center gap-2 mb-8 uppercase tracking-widest">
          <Download className="w-5 h-5 text-primary-blue" />
          本機資料與 Google 雲端備份
        </h2>
        <div className="space-y-4">
          <p className="px-2 text-[12px] font-medium text-ink/60 leading-relaxed mb-4">
            由於應用程式已轉為完全在設備本地運行，我們強烈建議您定期將資料匯出為 JSON，並上傳至您的 <strong>Google 雲端硬碟</strong> 進行妥善備份。
          </p>

          <div className="flex gap-4">
            <button onClick={handleExportData} className="flex-1 bg-background text-ink p-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-divider transition-all border border-divider">
              <Download className="w-4 h-4" /> 匯出 JSON 備份
            </button>
            <label className="flex-1 bg-background text-ink p-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-divider transition-all cursor-pointer border border-divider">
              <Upload className="w-4 h-4" /> 匯入還原
              <input type="file" accept=".json" onChange={handleImportData} className="hidden" />
            </label>
          </div>
        </div>
      </section>

      {/* AI Status */}
      <section className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider">
        <h2 className="text-lg font-serif font-bold text-ink flex items-center gap-2 mb-8 uppercase tracking-widest">
          <Database className="w-5 h-5 text-primary-blue" />
          AI 辨識狀態
        </h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-5 bg-background rounded-3xl border border-divider">
            <div>
              <p className="font-serif font-bold text-ink text-lg text-primary-blue">Gemini 3 系列次世代引擎</p>
              <p className="text-[10px] font-bold text-ink/40 uppercase tracking-widest mt-1">
                已偵測到可用金鑰數：
                <span className="text-primary-blue ml-2">
                  {(() => {
                    const keys: number[] = [];
                    if (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) keys.push(1);
                    if (import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.GEMINI_API_KEY) keys.push(1);
                    if (import.meta.env.VITE_GEMINI_KEY_2) keys.push(2);
                    if (import.meta.env.VITE_GEMINI_KEY_3) keys.push(3);
                    if (import.meta.env.VITE_GEMINI_KEY_4) keys.push(4);
                    if (import.meta.env.VITE_GEMINI_KEY_5) keys.push(5);
                    return Array.from(new Set(keys)).length;
                  })()} / 5
                </span>
              </p>
            </div>
            <div className="flex flex-col items-end">
              <span className="px-3 py-1 bg-green-100 text-green-600 rounded-full text-[10px] font-bold uppercase tracking-widest">
                自動負載平衡
              </span>
            </div>
          </div>
          <p className="px-2 text-[10px] font-medium text-ink/40 leading-relaxed italic">
            系統會自動在可用金鑰間切換（Rotational Key Strategy），以避免單一金鑰頻率限制。若需增加額度，請在 Secrets 面板新增 VITE_GEMINI_KEY_2 ~ 5。
          </p>
        </div>
      </section>

      {/* Payment Accounts Section */}
      <section className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider">
        <h2 className="text-lg font-serif font-bold text-ink flex items-center gap-2 mb-8 uppercase tracking-widest">
          <CreditCard className="w-5 h-5 text-primary-blue" />
          支付帳戶管理
        </h2>
        
        <form onSubmit={handleAddAccount} className="space-y-4 mb-8">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">帳戶名稱</label>
            <input
              type="text"
              placeholder="如: 老闆A銀行卡"
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium"
              required
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">類型</label>
              <input
                list="account-types"
                value={newAccountType}
                onChange={(e) => setNewAccountType(e.target.value)}
                placeholder="選擇或輸入類型"
                className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium"
              />
              <datalist id="account-types">
                {existingTypes.map(type => (
                  <option key={type} value={type} />
                ))}
                {!existingTypes.includes('日幣現金') && <option value="日幣現金" />}
                {!existingTypes.includes('信用卡') && <option value="信用卡" />}
                {!existingTypes.includes('交通卡') && <option value="交通卡" />}
              </datalist>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">幣別</label>
              <input
                list="account-currencies"
                value={newAccountCurrency}
                onChange={(e) => setNewAccountCurrency(e.target.value)}
                placeholder="如: JPY, TWD"
                className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium"
              />
              <datalist id="account-currencies">
                {existingCurrencies.map(curr => (
                  <option key={curr} value={curr} />
                ))}
                {!existingCurrencies.includes('JPY') && <option value="JPY" />}
                {!existingCurrencies.includes('TWD') && <option value="TWD" />}
                {!existingCurrencies.includes('USD') && <option value="USD" />}
              </datalist>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">初始餘額</label>
            <input
              type="number"
              placeholder="0"
              value={newAccountBalance}
              onChange={(e) => setNewAccountBalance(e.target.value)}
              className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium"
              required
            />
          </div>
          
          <button type="submit" className="w-full bg-primary-blue text-white font-bold p-4 rounded-2xl shadow-lg shadow-primary-blue/20 hover:bg-primary-blue/90 flex items-center justify-center gap-2 transition-all active:scale-95 uppercase tracking-widest text-xs">
            <Plus className="w-5 h-5" />
            新增帳戶
          </button>
        </form>

        <div className="space-y-4">
          <p className="text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4 mb-2">現有帳戶</p>
          {accounts.map((account, index) => (
            <div key={account.id} className="p-5 bg-background rounded-3xl border border-divider group transition-all hover:shadow-md">
              {editingAccountId === account.id ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[8px] font-bold text-ink/40 uppercase tracking-widest ml-2">帳戶名稱</label>
                    <input
                      type="text"
                      value={editAccountData.name}
                      onChange={e => setEditAccountData({...editAccountData, name: e.target.value})}
                      className="w-full p-3 bg-card-white border border-divider rounded-xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[8px] font-bold text-ink/40 uppercase tracking-widest ml-2">類型</label>
                      <input
                        list="account-types-edit"
                        value={editAccountData.type}
                        onChange={e => setEditAccountData({...editAccountData, type: e.target.value})}
                        className="w-full p-3 bg-card-white border border-divider rounded-xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium text-sm"
                      />
                      <datalist id="account-types-edit">
                        {existingTypes.map(type => <option key={type} value={type} />)}
                      </datalist>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[8px] font-bold text-ink/40 uppercase tracking-widest ml-2">幣別</label>
                      <input
                        list="account-currencies-edit"
                        value={editAccountData.currency}
                        onChange={e => setEditAccountData({...editAccountData, currency: e.target.value})}
                        className="w-full p-3 bg-card-white border border-divider rounded-xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium text-sm"
                      />
                      <datalist id="account-currencies-edit">
                        {existingCurrencies.map(curr => <option key={curr} value={curr} />)}
                      </datalist>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[8px] font-bold text-ink/40 uppercase tracking-widest ml-2">餘額</label>
                    <input
                      type="number"
                      value={editAccountData.balance}
                      onChange={e => setEditAccountData({...editAccountData, balance: e.target.value})}
                      className="w-full p-3 bg-card-white border border-divider rounded-xl focus:ring-2 focus:ring-primary-blue/20 outline-none text-ink font-medium text-sm"
                    />
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleSaveEdit}
                      className="flex-1 bg-primary-blue text-white font-bold py-2 rounded-xl flex items-center justify-center gap-1 text-xs"
                    >
                      <Check className="w-4 h-4" /> 儲存
                    </button>
                    <button
                      onClick={() => setEditingAccountId(null)}
                      className="flex-1 bg-divider text-ink/60 font-bold py-2 rounded-xl flex items-center justify-center gap-1 text-xs"
                    >
                      <CloseIcon className="w-4 h-4" /> 取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col gap-1">
                      <button
                        onClick={() => handleMoveAccount(index, 'up')}
                        disabled={index === 0}
                        className="p-1 text-ink/20 hover:text-primary-blue disabled:opacity-0 transition-all"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleMoveAccount(index, 'down')}
                        disabled={index === accounts.length - 1}
                        className="p-1 text-ink/20 hover:text-primary-blue disabled:opacity-0 transition-all"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                    </div>
                    <div>
                      <p className="font-serif font-bold text-ink text-lg">{account.name}</p>
                      <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-ink/40 mt-1">
                        <span className="bg-divider px-2 py-0.5 rounded-full text-ink/60">{account.type}</span>
                        <span className="text-primary-blue">{account.currency || 'JPY'} {account.balance.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button 
                      onClick={() => handleStartEdit(account)} 
                      className="p-2 text-ink/20 hover:text-primary-blue hover:bg-primary-blue/5 rounded-xl transition-all"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => handleDeleteAccount(account.id)} 
                      className="p-2 text-ink/20 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {accounts.length === 0 && (
            <div className="text-center py-8 text-ink/30 text-sm font-medium">
              尚未設定支付帳戶
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
