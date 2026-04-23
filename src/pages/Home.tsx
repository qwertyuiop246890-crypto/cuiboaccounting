import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, orderBy, onSnapshot, doc, getDoc, deleteDoc, updateDoc, increment, getDocs, getDocsFromCache, getDocFromCache, where } from '../lib/local-db';
import { db, auth } from '../firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';
import { format } from 'date-fns';
import { Camera, Receipt as ReceiptIcon, CreditCard, Trash2, Landmark, RefreshCw, Sparkles, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Modal } from '../components/ui/Modal';
import { normalizeDate } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { Check } from 'lucide-react';

export function Home() {
  const [receipts, setReceipts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>(() => {
    return (localStorage.getItem('cuibo_sort_order') as 'desc' | 'asc') || 'desc';
  });
  const [showSortToast, setShowSortToast] = useState(false);

  useEffect(() => {
    localStorage.setItem('cuibo_sort_order', sortOrder);
    // 只有在非初始渲染且有收據時才顯示成功提示
    if (receipts.length > 0) {
      setShowSortToast(true);
      const timer = setTimeout(() => setShowSortToast(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [sortOrder]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [repairLoading, setRepairLoading] = useState(false);

  const repairAllDates = async () => {
    if (!auth.currentUser || repairLoading) return;
    setRepairLoading(true);
    try {
      const uid = auth.currentUser.uid;
      const receiptsSnap = await getDocs(collection(db, `users/${uid}/receipts`));
      const refundsSnap = await getDocs(collection(db, `users/${uid}/taxRefunds`));
      
      const batch: Promise<void>[] = [];
      let repairCount = 0;
      
      receiptsSnap.docs.forEach(docSnap => {
        const data = docSnap.data();
        if (data.date) {
            // 關鍵對齊邏輯：將 ' ' 轉換為 'T'，並移除所有 '.' 或 '/' 分隔符號
            const cleanDate = normalizeDate(data.date);
            if (cleanDate !== data.date) {
                repairCount++;
                batch.push(updateDoc(doc(db, `users/${uid}/receipts/${docSnap.id}`), { 
                  date: cleanDate,
                  lastDataWash: new Date().toISOString() // 記錄數據清洗時間
                }));
            }
        }
      });
      
      refundsSnap.docs.forEach(docSnap => {
        const data = docSnap.data();
        if (data.date) {
            const cleanDate = normalizeDate(data.date);
            if (cleanDate !== data.date) {
                repairCount++;
                batch.push(updateDoc(doc(db, `users/${uid}/taxRefunds/${docSnap.id}`), { 
                  date: cleanDate,
                  lastDataWash: new Date().toISOString()
                }));
            }
        }
      });

      if (batch.length > 0) {
        await Promise.all(batch);
        setModalConfig({
          isOpen: true,
          title: '✨ 數據清洗完成 (Global Wash)',
          message: `全站日期校準引擎已掃描完畢！成功將 ${repairCount} 筆單據的「空格」或「分隔符號」校准為標準時序格式 (YYYY-MM-DDTHH:mm)。\n\n這將大幅提升排序穩定性，讓您的單據按正確時間排位。`,
          type: 'success'
        });
      } else {
        setModalConfig({
          isOpen: true,
          title: '✅ 數據高度標準化',
          message: '檢查完畢！目前您的所有單據均已符合標準時序規格，無需進一步清洗。您的排序系統處於最佳狀態。',
          type: 'info'
        });
      }
    } catch (e) {
      console.error(e);
      setModalConfig({
        isOpen: true,
        title: '校準引擎中斷',
        message: '執行全站數據清洗時發生異常。請檢查網路連線或稍後再試。',
        type: 'error'
      });
    } finally {
      setRepairLoading(false);
    }
  };
  const navigate = useNavigate();

  // Modal State
  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'info' | 'success' | 'error' | 'confirm';
    onConfirm?: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info'
  });

  useEffect(() => {
    if (!auth.currentUser) return;

    // Migration Script for English to Chinese Categories and missing sorting fields
    const runMigration = async () => {
      const uid = auth.currentUser!.uid;
      const migrateKey = `migrated_${uid}_v2`;
      if (localStorage.getItem(migrateKey)) return;

      try {
        // Migrate Receipts
        const receiptsSnap = await getDocs(collection(db, `users/${uid}/receipts`));
        let index = 0;
        for (const docSnapshot of receiptsSnap.docs) {
          const data = docSnapshot.data();
          let needsUpdate = false;
          const updates: any = {};

          if (data.category === 'Business') { updates.category = '進貨'; needsUpdate = true; }
          if (data.category === 'Personal') { updates.category = '私人'; needsUpdate = true; }

          const subCategoryMap: Record<string, string> = {
            'Food': '飲食', 'Clothing': '服飾', 'Housing': '居住',
            'Transport': '交通', 'Education': '教育', 'Entertainment': '娛樂', 'Other': '其他'
          };
          if (data.subCategory && subCategoryMap[data.subCategory]) {
            updates.subCategory = subCategoryMap[data.subCategory];
            needsUpdate = true;
          }

          if (data.date) {
            if (data.date.includes('Z')) {
              try {
                const localFormatted = format(new Date(data.date), "yyyy-MM-dd'T'HH:mm");
                if (data.date !== localFormatted) {
                  updates.date = localFormatted;
                  needsUpdate = true;
                }
              } catch (e) {
                console.error(e);
              }
            } else if (data.date.length > 16) {
              updates.date = data.date.substring(0, 16);
              needsUpdate = true;
            }
          }

          if (!data.createdAt) {
            // Assign a unique createdAt based on current time + offset to fix sorting
            // We use the current time during migration to ensure they are unique and stable
            const migrateTime = new Date();
            migrateTime.setMilliseconds(migrateTime.getMilliseconds() + index);
            updates.createdAt = migrateTime.toISOString();
            needsUpdate = true;
          }

          if (needsUpdate) {
            await updateDoc(doc(db, `users/${uid}/receipts/${docSnapshot.id}`), updates);
          }

          // Migrate Items for this receipt
          const itemsSnap = await getDocs(collection(db, `users/${uid}/receipts/${docSnapshot.id}/items`));
          let itemIndex = 0;
          for (const itemDoc of itemsSnap.docs) {
            const itemData = itemDoc.data();
            if (!itemData.createdAt) {
              const itemMigrateTime = new Date();
              itemMigrateTime.setMilliseconds(itemMigrateTime.getMilliseconds() + itemIndex);
              await updateDoc(doc(db, `users/${uid}/receipts/${docSnapshot.id}/items/${itemDoc.id}`), {
                createdAt: itemMigrateTime.toISOString()
              });
            }
            itemIndex++;
          }
          index++;
        }

        // Migrate Payment Accounts
        const accountsSnap = await getDocs(collection(db, `users/${uid}/paymentAccounts`));
        for (const docSnapshot of accountsSnap.docs) {
          const data = docSnapshot.data();
          let needsUpdate = false;
          const updates: any = {};

          const typeMap: Record<string, string> = {
            'JPY Cash': '日幣現金',
            'Credit Card': '信用卡',
            'IC Card': '交通卡'
          };

          if (data.type && typeMap[data.type]) {
            updates.type = typeMap[data.type];
            needsUpdate = true;
          }

          if (needsUpdate) {
            await updateDoc(doc(db, `users/${uid}/paymentAccounts/${docSnapshot.id}`), updates);
          }
        }
        localStorage.setItem(migrateKey, 'true');
      } catch (error) {
        console.warn("Migration skipped or failed due to quota/network", error);
      }
    };
    
    runMigration();
    
    // Subscribe to both so they stay live when offline
    const qReceipts = query(
      collection(db, `users/${auth.currentUser.uid}/receipts`),
      orderBy('date', 'desc'),
      orderBy('createdAt', 'desc')
    );
    const qRefunds = query(
      collection(db, `users/${auth.currentUser.uid}/taxRefunds`),
      orderBy('date', 'desc'),
      orderBy('createdAt', 'desc')
    );
    const qAccounts = collection(db, `users/${auth.currentUser.uid}/paymentAccounts`);
    
    let currentReceipts: any[] = [];
    let currentRefunds: any[] = [];
    let currentAccounts = new Map();

    const fetchData = async () => {
        const uid = auth.currentUser!.uid;
        
        try {
            const qAccounts = collection(db, `users/${uid}/paymentAccounts`);
            const receiptsRef = collection(db, `users/${uid}/receipts`);
            const refundsRef = collection(db, `users/${uid}/taxRefunds`);

            // Use the locally fetched snapshot values
            const [accountsSnap, receiptsSnap, refundsSnap] = await Promise.all([
                getDocs(qAccounts),
                getDocs(receiptsRef),
                getDocs(refundsRef)
            ]);

            currentAccounts.clear();
            accountsSnap.docs.forEach(doc => currentAccounts.set(doc.id, doc.data().name));
            
            currentReceipts = receiptsSnap.docs.map(doc => ({ id: doc.id, _type: 'receipt', ...doc.data() }));
            currentRefunds = refundsSnap.docs.map(doc => ({ id: doc.id, _type: 'taxRefund', ...doc.data() }));
            
            const combinedData = [...currentReceipts, ...currentRefunds].sort((a: any, b: any) => {
                const dateA = normalizeDate(a.date || '');
                const dateB = normalizeDate(b.date || '');
                if (dateB !== dateA) {
                    const timeA = new Date(dateA).getTime();
                    const timeB = new Date(dateB).getTime();
                    if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) return timeB - timeA;
                    return dateB.localeCompare(dateA);
                }
                
                const createA = a.createdAt || '';
                const createB = b.createdAt || '';
                const cTimeA = new Date(createA).getTime();
                const cTimeB = new Date(createB).getTime();
                if (!isNaN(cTimeA) && !isNaN(cTimeB) && cTimeA !== cTimeB) return cTimeB - cTimeA;

                return createB.localeCompare(createA);
            });

            const enrichedData = combinedData.map((item: any) => {
                let paymentName = 'Unknown Payment';
                if (item.paymentAccountId && currentAccounts.has(item.paymentAccountId)) {
                    paymentName = currentAccounts.get(item.paymentAccountId);
                }
                return { ...item, paymentName };
            });

            setReceipts(enrichedData);
            setLoading(false);
        } catch (error: any) {
            console.error("Fetch failed:", error);
            setLoading(false);
        }
    };

    // Listen for changes in all related collections
    const unsubReceipts = onSnapshot(collection(db, `users/${auth.currentUser.uid}/receipts`), fetchData);
    const unsubRefunds = onSnapshot(collection(db, `users/${auth.currentUser.uid}/taxRefunds`), fetchData);
    const unsubAccounts = onSnapshot(collection(db, `users/${auth.currentUser.uid}/paymentAccounts`), fetchData);

    return () => {
      unsubReceipts();
      unsubRefunds();
      unsubAccounts();
    };
  }, []);

  const handleDelete = async (e: React.MouseEvent, receipt: any) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!auth.currentUser) return;

    setModalConfig({
      isOpen: true,
      title: '確認刪除',
      message: '確定要刪除此單據嗎？此動作無法復原，且會自動回退帳戶餘額。',
      type: 'confirm',
      onConfirm: async () => {
        try {
          // Restore account balance if account exists
          if (receipt.paymentAccountId) {
            const accountRef = doc(db, `users/${auth.currentUser!.uid}/paymentAccounts/${receipt.paymentAccountId}`);
            let accountSnap;
            try {
              // 優先嘗試連網，失敗或離線時改用快取
              accountSnap = await getDoc(accountRef);
            } catch (e) {
              console.warn("Offline delete: fetching account from cache");
              accountSnap = await getDocFromCache(accountRef).catch(() => null);
            }
            
            if (accountSnap && accountSnap.exists()) {
              // If it's a receipt, deleting it refunds the balance. If it's a tax refund, deleting it deducts the balance.
              const incrementAmount = receipt._type === 'taxRefund' ? -receipt.amount : (receipt.totalAmount || 0);
              updateDoc(accountRef, { balance: increment(incrementAmount) }).catch(e=>console.warn("Balance update queued", e));
            }
          }

          if (receipt._type === 'taxRefund') {
            deleteDoc(doc(db, `users/${auth.currentUser!.uid}/taxRefunds/${receipt.id}`)).catch(e=>console.warn(e));
          } else {
            // Delete associated items for receipts
            try {
              const itemsRef = collection(db, `users/${auth.currentUser!.uid}/receipts/${receipt.id}/items`);
              let itemsSnap;
              try {
                itemsSnap = await getDocs(itemsRef);
              } catch (e) {
                console.warn("Offline delete: fetching items from cache");
                itemsSnap = await getDocsFromCache(itemsRef).catch(() => ({ docs: [] }));
              }

              if (itemsSnap && itemsSnap.docs) {
                itemsSnap.docs.forEach(itemDoc => 
                  deleteDoc(doc(db, `users/${auth.currentUser!.uid}/receipts/${receipt.id}/items/${itemDoc.id}`)).catch(e=>console.warn(e))
                );
              }
            } catch (error) {
               console.error("Failed to fetch/delete receipt items:", error);
            }

            // Delete receipt
            deleteDoc(doc(db, `users/${auth.currentUser!.uid}/receipts/${receipt.id}`)).catch(e=>console.warn(e));
          }

          setModalConfig(prev => ({ ...prev, isOpen: false }));
        } catch (error) {
          console.error('Error deleting receipt:', error);
          setModalConfig({
            isOpen: true,
            title: '錯誤',
            message: '刪除失敗，請稍後再試。',
            type: 'error'
          });
        }
      }
    });
  };

  const filteredReceipts = useMemo(() => {
    let result = [...receipts];
    if (selectedDate) {
      result = result.filter(r => {
        const normalizedItemDate = normalizeDate(r.date || '');
        return normalizedItemDate.startsWith(selectedDate);
      });
    }
    return result.sort((a, b) => {
      const dateA = normalizeDate(a.date || '');
      const dateB = normalizeDate(b.date || '');
      
      if (dateA !== dateB) {
        // Fallback to safe numeric comparison if possible, else standard localeCompare
        const timeA = new Date(dateA).getTime();
        const timeB = new Date(dateB).getTime();
        
        if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
          return sortOrder === 'desc' ? timeB - timeA : timeA - timeB;
        }
        return sortOrder === 'desc' ? dateB.localeCompare(dateA) : dateA.localeCompare(dateB);
      }
      
      // 只有在日期完全相同時才使用 createdAt 作為唯一標識排序，確保穩定性
      const createA = a.createdAt || '';
      const createB = b.createdAt || '';
      const cTimeA = new Date(createA).getTime();
      const cTimeB = new Date(createB).getTime();
      
      if (!isNaN(cTimeA) && !isNaN(cTimeB) && cTimeA !== cTimeB) {
          return sortOrder === 'desc' ? cTimeB - cTimeA : cTimeA - cTimeB;
      }

      return sortOrder === 'desc' ? createB.localeCompare(createA) : createA.localeCompare(createB);
    });
  }, [receipts, selectedDate, sortOrder]);

  const COLORS = ['#AEC8DB', '#957E6B', '#D9C5B2', '#B8C5D6', '#E5D3C5', '#C4D7E0', '#A3B18A'];

  return (
    <div className="p-4 max-w-md mx-auto pb-24 bg-background min-h-screen">
      <header className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="w-16 h-16 rounded-[28px] overflow-hidden border-[6px] border-white shadow-sm">
            <img src="/logo.png" alt="Cui Bo" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          </div>
          <div>
            <h1 className="text-[28px] font-serif font-bold text-ink leading-tight">Cui Bo</h1>
            <p className="text-[12px] font-bold text-ink/40 tracking-widest mt-0.5">記帳軟體</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={repairAllDates}
            disabled={repairLoading}
            className={`p-3 rounded-2xl transition-all shadow-sm bg-white border border-divider/40 hover:shadow-md hover:scale-110 active:scale-95 ${repairLoading ? 'opacity-50' : 'text-primary-blue'}`}
            title="Global Date Calibration Engine"
          >
            <Sparkles className={`w-5 h-5 ${repairLoading ? 'animate-spin' : ''}`} />
          </button>
          <div className="w-12 h-12 rounded-full bg-accent-orange shadow-lg border-[3px] border-white flex items-center justify-center font-black text-white text-lg">
            波
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-4 mb-8">
        <button 
          onClick={() => navigate('/receipt/new')}
          className="col-span-2 bg-button-blue text-white rounded-[32px] p-10 flex flex-col items-center justify-center gap-4 shadow-sm active:scale-[0.98] transition-all"
        >
          <div className="bg-white/30 p-4 rounded-[22px] backdrop-blur-sm shadow-sm">
            <Camera className="w-9 h-9" />
          </div>
          <span className="text-xl font-bold tracking-widest">拍照新增單據</span>
        </button>

        <button 
          onClick={() => navigate('/tax-refund')}
          className="bg-card-white text-ink rounded-[32px] p-6 flex flex-col items-center justify-center gap-3 shadow-sm border border-divider/40 active:scale-95 transition-all group"
        >
          <div className="bg-soft-blue p-4 rounded-full">
            <Landmark className="w-6 h-6 text-primary-blue" />
          </div>
          <span className="text-sm font-bold text-ink/70">新增退稅紀錄</span>
        </button>

        <button 
          onClick={() => navigate('/transfer')}
          className="bg-card-white text-ink rounded-[32px] p-6 flex flex-col items-center justify-center gap-3 shadow-sm border border-divider/40 active:scale-95 transition-all group"
        >
          <div className="bg-soft-blue p-4 rounded-full">
            <CreditCard className="w-6 h-6 text-primary-blue" />
          </div>
          <span className="text-sm font-bold text-ink/70">內部資金轉移</span>
        </button>
      </div>

      <div className="space-y-4">
        {/* Visual Sync Toolbar */}
        <div className="bg-white p-4 rounded-3xl border border-divider/40 shadow-sm flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ReceiptIcon className="w-5 h-5 text-ink/40" />
            <h2 className="text-sm font-bold text-ink tracking-widest whitespace-nowrap">明細單據</h2>
          </div>
          
          <div className="flex items-center gap-2 flex-1">
            <div className="flex-1 bg-[#F4EDE3] rounded-2xl flex items-center px-4 py-2 relative">
               <span className="text-[10px] font-bold text-ink/30 mr-2 uppercase">排序</span>
               <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as 'desc' | 'asc')}
                className="w-full text-xs font-bold border-none bg-transparent outline-none text-ink/70 cursor-pointer"
              >
                <option value="desc">由新到舊</option>
                <option value="asc">由舊到新</option>
              </select>
              {/* 功能啟用與成功儲存標示 */}
              <div className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border border-white shadow-sm transition-all duration-300 ${showSortToast ? 'bg-green-500 scale-125' : 'bg-primary-blue/30'}`} title="排序功能已啟用並自動儲存" />
              
              <AnimatePresence>
                {showSortToast && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="absolute -bottom-8 left-0 right-0 flex justify-center z-20"
                  >
                    <div className="bg-ink text-white text-[9px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-lg">
                      <Check className="w-2 h-2" />
                      已自動儲存排序方式
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="flex-1 bg-[#F4EDE3] rounded-2xl flex items-center px-4 py-2 relative">
               <span className="text-[10px] font-bold text-ink/30 mr-2 uppercase">篩選</span>
               <input 
                type="date" 
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full text-xs border-none bg-transparent outline-none font-bold text-ink cursor-pointer"
              />
              {selectedDate && (
                <button 
                  onClick={() => setSelectedDate('')}
                  className="absolute right-2 text-ink/30 hover:text-red-500"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>
        
        {loading ? (
          <div className="text-center py-8 text-ink/50 animate-pulse font-medium">載入中...</div>
        ) : filteredReceipts.length === 0 ? (
          <div className="text-center py-16 bg-transparent rounded-[32px] border-2 border-dashed border-ink/10">
            <ReceiptIcon className="w-16 h-16 text-ink/10 mx-auto mb-4" />
            <p className="text-ink text-lg font-bold">尚無記帳紀錄</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredReceipts.map((receipt) => (
              <Link 
                key={receipt.id} 
                to={receipt._type === 'taxRefund' ? `/tax-refund/${receipt.id}` : `/receipt/${receipt.id}`}
                className="block bg-card-white p-4 rounded-3xl shadow-sm border border-divider hover:border-primary-blue/50 transition-all group relative active:scale-[0.98]"
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-4">
                    {receipt.photoUrl ? (
                      <img src={receipt.photoUrl || undefined} alt="Receipt" className="w-14 h-14 rounded-2xl object-cover shadow-sm" />
                    ) : (
                      <div className="w-14 h-14 rounded-2xl bg-background flex items-center justify-center">
                        {receipt._type === 'taxRefund' ? (
                          <Landmark className="w-6 h-6 text-ink/30" />
                        ) : (
                          <ReceiptIcon className="w-6 h-6 text-ink/30" />
                        )}
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <div className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          receipt._type === 'taxRefund' 
                            ? 'bg-[#A3B18A]/20 text-[#6B7558]'
                            : (receipt.category === 'Business' || receipt.category === '進貨')
                              ? 'bg-[#E5D3C5] text-[#957E6B]' 
                              : 'bg-[#C4D7E0] text-[#5A7D9A]'
                        }`}>
                          {receipt._type === 'taxRefund' ? '退稅收入' : (receipt.category === 'Business' || receipt.category === '進貨' ? '進貨' : '私人')}
                        </div>
                        <span className="text-[10px] font-bold text-ink/40 uppercase tracking-widest">
                          {(() => {
                            const d = normalizeDate(receipt.date);
                            if (d.length >= 16) {
                              const [datePart, timePart] = d.split('T');
                              const [y, m, day] = datePart.split('-');
                              const currentYear = new Date().getFullYear().toString();
                              // 如果年份不是今年，則顯示年份
                              const displayDate = y !== currentYear ? `${y}/${m}/${day}` : `${m}/${day}`;
                              return `${displayDate} ${timePart}`;
                            }
                            return d;
                          })()}
                        </span>
                      </div>
                      
                      {receipt.storeName ? (
                        <p className="font-bold text-ink text-sm mb-0.5 truncate max-w-[150px]">{receipt.storeName}</p>
                      ) : receipt.notes ? (
                        <p className="font-bold text-ink text-sm mb-0.5 truncate max-w-[150px]">{receipt.notes}</p>
                      ) : receipt._type === 'taxRefund' && (
                         <p className="font-bold text-ink text-sm mb-0.5 truncate max-w-[150px]">退稅紀錄</p>
                      )}
                      
                      <div className="flex flex-col gap-0.5 text-xs text-ink/70 font-medium">
                        <div className="flex items-center gap-1">
                          <CreditCard className="w-3 h-3 text-ink/30" />
                          <span className="truncate max-w-[120px]">{receipt.paymentName}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span className={`font-serif font-bold text-xl ${receipt._type === 'taxRefund' ? 'text-[#6B7558]' : 'text-ink'}`}>
                      {receipt._type === 'taxRefund' ? '+' : ''}{receipt.currency || 'JPY'} {(receipt.amount !== undefined ? receipt.amount : receipt.totalAmount).toLocaleString()}
                    </span>
                    <button 
                      onClick={(e) => handleDelete(e, receipt)}
                      className="p-2 text-ink/20 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      
      <Modal
        isOpen={modalConfig.isOpen}
        onClose={() => setModalConfig(prev => ({ ...prev, isOpen: false }))}
        onConfirm={modalConfig.onConfirm}
        title={modalConfig.title}
        message={modalConfig.message}
        type={modalConfig.type}
      />
    </div>
  );
}
