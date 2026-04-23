import { useState, useEffect, useMemo } from 'react';
import { collection, query, onSnapshot, getDocs } from '../lib/local-db';
import { db, auth } from '../firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { format, subDays, isWithinInterval, startOfDay, endOfDay, parseISO } from 'date-fns';
import { Calendar, Filter, PieChart as PieChartIcon } from 'lucide-react';
import { normalizeDate } from '../lib/utils';

export function Dashboard() {
  const [receipts, setReceipts] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [startDate, setStartDate] = useState<string>(format(subDays(new Date(), 30), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [showAllDates, setShowAllDates] = useState(false);
  const [selectedCurrency, setSelectedCurrency] = useState<string>('');
  const [itemsMap, setItemsMap] = useState<Record<string, any[]>>({});

  useEffect(() => {
    if (!auth.currentUser) return;

    const fetchData = () => {
      try {
        const unsubReceipts = onSnapshot(collection(db, `users/${auth.currentUser!.uid}/receipts`), (snap: any) => {
          const data = snap.docs.map((d: any) => ({ id: d.id, _type: 'receipt', ...d.data() }));
          // Note: we'll merge them in the receipts state for simplicity in the display/calc logic
          setReceipts(prev => {
            const others = prev.filter(r => r._type !== 'receipt');
            return [...others, ...data];
          });
        });

        const unsubRefunds = onSnapshot(collection(db, `users/${auth.currentUser!.uid}/taxRefunds`), (snap: any) => {
          const data = snap.docs.map((d: any) => ({ id: d.id, _type: 'taxRefund', ...d.data() }));
          setReceipts(prev => {
            const others = prev.filter(r => r._type !== 'taxRefund');
            return [...others, ...data];
          });
        });

        const unsubAccounts = onSnapshot(collection(db, `users/${auth.currentUser!.uid}/paymentAccounts`), (snap: any) => {
          setAccounts(snap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
        });

        return () => {
          unsubReceipts();
          unsubRefunds();
          unsubAccounts();
        };
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `users/${auth.currentUser?.uid}/dashboard`);
      }
    };

    const cleanup = fetchData();
    return () => cleanup && cleanup();
  }, [selectedCurrency]);

  const filteredReceipts = useMemo(() => {
    let filtered = receipts;
    if (!showAllDates) {
      const start = startOfDay(new Date(startDate));
      const end = endOfDay(new Date(endDate));
      filtered = receipts.filter(r => {
        if (!r.date) return false;
        const normalized = normalizeDate(r.date);
        try {
          const rDate = parseISO(normalized);
          return isWithinInterval(rDate, { start, end });
        } catch (e) {
          console.warn("Dashboard date parse failed", r.date, e);
          return false;
        }
      });
    }
    return filtered;
  }, [receipts, startDate, endDate, showAllDates]);

  useEffect(() => {
    if (!auth.currentUser || filteredReceipts.length === 0) return;
    
    // 改為按需一次性抓取明細，而非開啟監聽器
    const fetchItems = async () => {
        const newMap = { ...itemsMap };
        let hasChanges = false;
        
        for (const r of filteredReceipts) {
            if (!newMap[r.id]) {
                try {
                    const snap = await getDocs(collection(db, `users/${auth.currentUser!.uid}/receipts/${r.id}/items`));
                    newMap[r.id] = snap.docs.map(d => d.data());
                    hasChanges = true;
                } catch (err) {
                    console.warn(`Failed fetching items for receipt ${r.id}`, err);
                    newMap[r.id] = [];
                }
            }
        }
        
        if (hasChanges) {
            setItemsMap(newMap);
        }
    };
    
    fetchItems();
  }, [filteredReceipts]);

  const availableCurrencies = useMemo(() => {
    return Array.from(new Set(filteredReceipts.map(r => r.currency || 'JPY')));
  }, [filteredReceipts]);

  useEffect(() => {
    if (availableCurrencies.length > 0 && !availableCurrencies.includes(selectedCurrency)) {
      setSelectedCurrency(availableCurrencies[0]);
    }
  }, [availableCurrencies, selectedCurrency]);

  const stats = useMemo(() => {
    let total = 0;
    let business = 0;
    let personal = 0;
    let totalDiscount = 0;
    let totalTaxRefund = 0;
    const paymentUsage: Record<string, number> = {};
    const personalUsage: Record<string, number> = {};
    const businessUsage: Record<string, number> = {};

    const currencyFiltered = filteredReceipts.filter(r => (r.currency || 'JPY') === selectedCurrency);

    currencyFiltered.forEach(r => {
      const amount = r._type === 'taxRefund' ? (r.amount || 0) : (r.totalAmount || 0);
      
      // If it's a tax refund, it doesn't count as "expense", it's "income" or "reduction"
      // But in this simple dashboard, we might want to subtract it or just track it separately.
      // Usually, tax refund is positive income.
      if (r._type === 'taxRefund') {
        totalTaxRefund += amount;
        return; // Don't add to general spending total
      }

      total += amount;
      totalDiscount += (r.totalDiscount || 0);
      totalTaxRefund += (r.totalTaxRefund || 0); // This is tax refund within a receipt
      
      let personalItemsTotal = 0;
      let giftItemsTotal = 0;
      
      if (itemsMap[r.id]) {
        itemsMap[r.id].forEach(item => {
          if (item.tag === '私人') personalItemsTotal += (Number(item.price) * Number(item.quantity));
          if (item.tag === '送禮') giftItemsTotal += (Number(item.price) * Number(item.quantity));
        });
      }

      const individualPersonalTotal = personalItemsTotal + giftItemsTotal;

      if (r.category === 'Business' || r.category === '進貨') {
        const busAmount = Math.max(0, r.totalAmount - individualPersonalTotal);
        business += busAmount;
        const subCat = r.subCategory || '商品成本';
        businessUsage[subCat] = (businessUsage[subCat] || 0) + busAmount;
        
        if (individualPersonalTotal > 0) {
          personal += individualPersonalTotal;
          if (personalItemsTotal > 0) personalUsage['私人明細'] = (personalUsage['私人明細'] || 0) + personalItemsTotal;
          if (giftItemsTotal > 0) personalUsage['送禮明細'] = (personalUsage['送禮明細'] || 0) + giftItemsTotal;
        }
      } else if (r.category === 'Personal' || r.category === '私人') {
        personal += r.totalAmount;
        const subCat = r.subCategory || '其他';
        const subMap: Record<string, string> = { 'Food': '飲食', 'Clothing': '服飾', 'Housing': '居住', 'Transport': '交通', 'Education': '教育', 'Entertainment': '娛樂', 'Other': '其他' };
        const translatedSub = subMap[subCat] || subCat;

        if (individualPersonalTotal > 0) {
           const genericPersonalAmount = Math.max(0, r.totalAmount - individualPersonalTotal);
           if (genericPersonalAmount > 0) {
             personalUsage[translatedSub] = (personalUsage[translatedSub] || 0) + genericPersonalAmount;
           }
           if (personalItemsTotal > 0) personalUsage['私人明細'] = (personalUsage['私人明細'] || 0) + personalItemsTotal;
           if (giftItemsTotal > 0) personalUsage['送禮明細'] = (personalUsage['送禮明細'] || 0) + giftItemsTotal;
        } else {
          personalUsage[translatedSub] = (personalUsage[translatedSub] || 0) + r.totalAmount;
        }
      }

      const accName = accounts.find(a => a.id === r.paymentAccountId)?.name || 'Unknown';
      paymentUsage[accName] = (paymentUsage[accName] || 0) + r.totalAmount;
    });

    const paymentData = Object.entries(paymentUsage).map(([name, value]) => ({ name, value }));
    const personalData = Object.entries(personalUsage).map(([name, value]) => ({ name, value }));
    const businessData = Object.entries(businessUsage).map(([name, value]) => ({ name, value }));
    const categoryData = [
      { name: '進貨支出', value: business },
      { name: '私人開銷', value: personal }
    ].filter(d => d.value > 0);

    return { total, business, personal, paymentData, personalData, businessData, categoryData, totalDiscount, totalTaxRefund };
  }, [filteredReceipts, accounts, selectedCurrency, itemsMap]);

  const COLORS = ['#AEC8DB', '#957E6B', '#D9C5B2', '#B8C5D6', '#E5D3C5', '#C4D7E0', '#A3B18A'];

  return (
    <div className="p-4 max-w-md mx-auto space-y-6 bg-background min-h-screen">
      <header className="flex flex-col gap-4 mb-6">
        <h1 className="text-2xl font-serif font-bold text-ink tracking-tight">報表與分析</h1>
        <div className="flex flex-col gap-3 bg-card-white p-4 rounded-3xl shadow-sm border border-divider">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-ink/40 flex-shrink-0" />
              <span className="text-[10px] font-bold text-ink/40 uppercase tracking-widest">日期範圍</span>
            </div>
            <button 
              onClick={() => setShowAllDates(!showAllDates)}
              className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all ${showAllDates ? 'bg-primary-blue text-white' : 'bg-background text-ink/40'}`}
            >
              全部日期
            </button>
          </div>
          
          {!showAllDates && (
            <div className="flex items-center gap-2 text-[10px] font-bold text-ink/40 uppercase tracking-widest whitespace-nowrap overflow-x-auto pb-1">
              <input 
                type="date" 
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-background rounded-lg p-1.5 px-2 outline-none focus:ring-2 focus:ring-primary-blue font-bold text-ink"
              />
              <span>至</span>
              <input 
                type="date" 
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-background rounded-lg p-1.5 px-2 outline-none focus:ring-2 focus:ring-primary-blue font-bold text-ink"
              />
            </div>
          )}
        </div>

        {availableCurrencies.length > 1 && (
          <div className="flex items-center gap-2 bg-card-white p-4 rounded-3xl shadow-sm border border-divider overflow-x-auto">
            <Filter className="w-4 h-4 text-ink/40 flex-shrink-0" />
            <div className="flex gap-2">
              {availableCurrencies.map(curr => (
                <button
                  key={curr}
                  onClick={() => setSelectedCurrency(curr)}
                  className={`px-4 py-2 rounded-2xl text-[10px] font-bold uppercase tracking-widest transition-all ${selectedCurrency === curr ? 'bg-ink text-white' : 'bg-background text-ink/40 border border-divider'}`}
                >
                  {curr}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 bg-primary-blue p-8 rounded-[40px] shadow-xl shadow-primary-blue/20 text-white relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-12 -mt-12" />
          <p className="text-white/70 text-xs font-bold uppercase tracking-[0.2em] mb-2 relative z-10">{selectedCurrency} 期間總花費</p>
          <p className="text-5xl font-serif font-bold tracking-tight relative z-10">{selectedCurrency} {stats.total.toLocaleString()}</p>
        </div>
        
        <div className="bg-card-white p-6 rounded-3xl shadow-sm border border-divider">
          <p className="text-ink/40 text-[10px] font-bold uppercase tracking-widest mb-2">進貨支出</p>
          <p className="text-2xl font-serif font-bold text-ink">{selectedCurrency} {stats.business.toLocaleString()}</p>
        </div>
        
        <div className="bg-card-white p-6 rounded-3xl shadow-sm border border-divider">
          <p className="text-ink/40 text-[10px] font-bold uppercase tracking-widest mb-2">私人開銷</p>
          <p className="text-2xl font-serif font-bold text-ink">{selectedCurrency} {stats.personal.toLocaleString()}</p>
        </div>

        {(stats.totalDiscount > 0 || stats.totalTaxRefund > 0) && (
          <>
            <div className="bg-card-white p-6 rounded-3xl shadow-sm border border-divider">
              <p className="text-ink/40 text-[10px] font-bold uppercase tracking-widest mb-2">總折扣金額</p>
              <p className="text-2xl font-serif font-bold text-green-600">{selectedCurrency} {stats.totalDiscount.toLocaleString()}</p>
            </div>
            <div className="bg-card-white p-6 rounded-3xl shadow-sm border border-divider">
              <p className="text-ink/40 text-[10px] font-bold uppercase tracking-widest mb-2">總退稅金額</p>
              <p className="text-2xl font-serif font-bold text-blue-600">{selectedCurrency} {stats.totalTaxRefund.toLocaleString()}</p>
            </div>
          </>
        )}
      </div>

      {/* Category Comparison Chart */}
      <div className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider">
        <h2 className="text-lg font-serif font-bold text-ink mb-8 flex items-center gap-2 uppercase tracking-widest">
          <PieChartIcon className="w-5 h-5 text-primary-blue" />
          支出類別佔比
        </h2>
        
        {stats.categoryData.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats.categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  <Cell fill="#E5D3C5" />
                  <Cell fill="#C4D7E0" />
                </Pie>
                <Tooltip 
                  formatter={(value: number) => `${selectedCurrency} ${value.toLocaleString()}`}
                  contentStyle={{ borderRadius: '20px', border: 'none', boxShadow: '0 4px 20px rgba(149, 126, 107, 0.1)', backgroundColor: '#FFFFFF' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '20px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-ink/30 text-sm font-medium">
            該期間尚無支出紀錄
          </div>
        )}
      </div>

      {/* Payment Usage Chart */}
      <div className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider">
        <h2 className="text-lg font-serif font-bold text-ink mb-8 flex items-center gap-2 uppercase tracking-widest">
          <Filter className="w-5 h-5 text-primary-blue" />
          支付工具佔比
        </h2>
        
        {stats.paymentData.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats.paymentData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {stats.paymentData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  formatter={(value: number) => `${selectedCurrency} ${value.toLocaleString()}`}
                  contentStyle={{ borderRadius: '20px', border: 'none', boxShadow: '0 4px 20px rgba(149, 126, 107, 0.1)', backgroundColor: '#FFFFFF' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '20px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-ink/30 text-sm font-medium">
            該期間尚無支出紀錄
          </div>
        )}
      </div>

      {/* Personal Expense Breakdown Chart */}
      <div className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider">
        <h2 className="text-lg font-serif font-bold text-ink mb-8 flex items-center gap-2 uppercase tracking-widest">
          <PieChartIcon className="w-5 h-5 text-primary-blue" />
          私人開銷佔比
        </h2>
        
        {stats.personalData.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats.personalData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {stats.personalData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  formatter={(value: number) => `${selectedCurrency} ${value.toLocaleString()}`}
                  contentStyle={{ borderRadius: '20px', border: 'none', boxShadow: '0 4px 20px rgba(149, 126, 107, 0.1)', backgroundColor: '#FFFFFF' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '20px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-ink/30 text-sm font-medium">
            該期間尚無私人支出紀錄
          </div>
        )}
      </div>

      {/* Business Expense Breakdown Chart */}
      <div className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider">
        <h2 className="text-lg font-serif font-bold text-ink mb-8 flex items-center gap-2 uppercase tracking-widest">
          <PieChartIcon className="w-5 h-5 text-primary-blue" />
          進貨支出佔比
        </h2>
        
        {stats.businessData.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats.businessData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {stats.businessData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  formatter={(value: number) => `${selectedCurrency} ${value.toLocaleString()}`}
                  contentStyle={{ borderRadius: '20px', border: 'none', boxShadow: '0 4px 20px rgba(149, 126, 107, 0.1)', backgroundColor: '#FFFFFF' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '20px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-ink/30 text-sm font-medium">
            該期間尚無進貨支出紀錄
          </div>
        )}
      </div>
    </div>
  );
}
