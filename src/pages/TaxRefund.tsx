import React, { useState, useEffect, useRef } from 'react';
import { collection, query, doc, setDoc, updateDoc, increment, orderBy, getDoc, getDocs, onSnapshot } from '../lib/local-db';
import { db, auth } from '../firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';
import { Sparkles, ArrowLeft, Landmark, Save, Camera, Image as ImageIcon, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { Modal } from '../components/ui/Modal';

const compressImage = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
};

const normalizeDate = (dateStr: string) => {
  if (!dateStr) return '';
  // Convert slash, dot or space to standardized T format for consistent Date parsing and localeCompare
  let normalized = dateStr.replace(/\//g, '-').replace(/\./g, '-').replace(' ', 'T').trim();
  try {
    const [datePart, timePart] = normalized.split('T');
    const dateParts = datePart.split('-');
    if (dateParts.length === 3) {
      let [year, month, day] = dateParts;
      if (year.length === 2) year = `20${year}`;
      month = month.padStart(2, '0');
      day = day.padStart(2, '0');
      let finalDate = `${year}-${month}-${day}`;
      if (timePart) {
        const timeSegments = timePart.split(':');
        const hour = (timeSegments[0] || '00').padStart(2, '0');
        const min = (timeSegments[1] || '00').padStart(2, '0');
        finalDate += `T${hour}:${min}`;
      } else {
        finalDate += 'T00:00';
      }
      return finalDate;
    }
  } catch (e) {
    console.warn("Date normalization failed", e);
  }
  return normalized;
};

export function TaxRefund() {
  const { id } = useParams();
  const isEdit = !!id;
  const [accounts, setAccounts] = useState<any[]>([]);
  const [amount, setAmount] = useState('');
  const [targetAccount, setTargetAccount] = useState('');
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd'T'HH:mm"));
  const [loading, setLoading] = useState(false);
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [originalAmount, setOriginalAmount] = useState(0);
  const [originalAccount, setOriginalAccount] = useState('');
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!auth.currentUser || !isEdit) return;
    const fetchRefund = async () => {
      try {
        const docRef = doc(db, `users/${auth.currentUser!.uid}/taxRefunds/${id}`);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          const data = snap.data();
          setAmount(data.amount?.toString() || '');
          setOriginalAmount(data.amount || 0);
          setTargetAccount(data.paymentAccountId || '');
          setOriginalAccount(data.paymentAccountId || '');
          setNotes(data.notes || '');
          if (data.date) {
            if (data.date.includes('Z')) {
               setDate(format(new Date(data.date), "yyyy-MM-dd'T'HH:mm"));
            } else {
               setDate(data.date.substring(0, 16));
            }
          }
          if (data.photoUrls) setPhotoUrls(data.photoUrls);
          if (data.photoUrl) setPhotoUrl(data.photoUrl);
        }
      } catch (e) {
         console.error(e);
      }
    };
    fetchRefund();
  }, [id, isEdit]);

  useEffect(() => {
    if (!auth.currentUser) return;

    const q = collection(db, `users/${auth.currentUser.uid}/paymentAccounts`);
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const accountsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const sortedAccounts = accountsData.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      setAccounts(sortedAccounts);
      
      // Default to cash account if exists and not editing
      if (!isEdit) {
        const cashAcc = sortedAccounts.find((a: any) => a.name.includes('現金') || a.name.includes('Cash'));
        if (cashAcc) setTargetAccount(cashAcc.id);
      }
    });

    return () => unsubscribe();
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      setLoading(true);
      const newPhotoUrls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const compressed = await compressImage(file);
        newPhotoUrls.push(compressed);
      }
      
      setPhotoUrls(prev => [...prev, ...newPhotoUrls]);
      if (!photoUrl) {
        setPhotoUrl(newPhotoUrls[0]);
      }
    } catch (error) {
      console.error("Error processing photo:", error);
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (galleryInputRef.current) galleryInputRef.current.value = '';
    }
  };

  const handlePhotoUpload = () => fileInputRef.current?.click();
  const handleGalleryUpload = () => galleryInputRef.current?.click();

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser || !amount || !targetAccount) return;

    setLoading(true);
    try {
      const refundAmount = Number(amount);
      const refundRef = isEdit
        ? doc(db, `users/${auth.currentUser.uid}/taxRefunds/${id}`)
        : doc(collection(db, `users/${auth.currentUser.uid}/taxRefunds`));
      
      const acc = accounts.find(a => a.id === targetAccount);

      try {
        if (isEdit) {
          updateDoc(refundRef, {
            date: normalizeDate(date),
            amount: refundAmount,
            paymentAccountId: targetAccount,
            currency: acc?.currency || 'JPY',
            notes: notes,
            photoUrl: photoUrls.length > 0 ? photoUrls[0] : '',
            photoUrls: photoUrls,
            updatedAt: new Date().toISOString()
          }).catch(e => console.warn(e));

          if (originalAccount === targetAccount) {
            const diff = refundAmount - originalAmount;
            if (diff !== 0) {
               updateDoc(doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${targetAccount}`), { balance: increment(diff) }).catch(e=>console.warn(e));
            }
          } else {
             if (originalAccount) {
               updateDoc(doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${originalAccount}`), { balance: increment(-originalAmount) }).catch(e=>console.warn(e));
             }
             updateDoc(doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${targetAccount}`), { balance: increment(refundAmount) }).catch(e=>console.warn(e));
          }
        } else {
          setDoc(refundRef, {
            date: normalizeDate(date),
            amount: refundAmount,
            paymentAccountId: targetAccount,
            currency: acc?.currency || 'JPY',
            notes: notes,
            photoUrl: photoUrls.length > 0 ? photoUrls[0] : '',
            photoUrls: photoUrls,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }).catch(e=>console.warn(e));

          updateDoc(doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${targetAccount}`), { balance: increment(refundAmount) }).catch(e=>console.warn(e));
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${auth.currentUser.uid}/taxRefunds`);
      }

      navigate('/');
    } catch (error) {
      console.error("Error saving tax refund:", error);
      setModalConfig({
        isOpen: true,
        title: '儲存失敗',
        message: '發生錯誤，請重試。',
        type: 'error'
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 max-w-md mx-auto bg-background min-h-screen">
      <Modal
        isOpen={modalConfig.isOpen}
        title={modalConfig.title}
        message={modalConfig.message}
        type={modalConfig.type}
        onClose={() => setModalConfig(prev => ({ ...prev, isOpen: false }))}
        onConfirm={modalConfig.onConfirm}
      />
      <header className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-2 bg-card-white rounded-full shadow-sm border border-divider hover:bg-divider transition-colors">
          <ArrowLeft className="w-5 h-5 text-ink" />
        </button>
        <h1 className="text-2xl font-serif font-bold text-ink flex items-center gap-2 tracking-tight">
          <Landmark className="w-6 h-6 text-primary-blue" />
          {isEdit ? '編輯退稅紀錄' : '新增退稅紀錄'}
        </h1>
      </header>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Hidden File Input for Camera */}
        <input 
          type="file" 
          accept="image/*" 
          capture="environment"
          multiple
          ref={fileInputRef} 
          onChange={handleFileChange} 
          className="hidden" 
        />

        {/* Hidden File Input for Gallery */}
        <input 
          type="file" 
          accept="image/*" 
          multiple
          ref={galleryInputRef} 
          onChange={handleFileChange} 
          className="hidden" 
        />

        <div className="bg-card-white p-8 rounded-[40px] shadow-sm border border-divider space-y-8 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary-blue/5 rounded-full -mr-12 -mt-12" />
          
          <div className="space-y-4">
            <label className="block text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">退稅明細照片 (選填)</label>
            <div className="grid grid-cols-2 gap-3 relative z-10">
              <button 
                type="button"
                onClick={!loading ? handlePhotoUpload : undefined}
                disabled={loading}
                className={`h-24 bg-background rounded-3xl border border-divider flex flex-col items-center justify-center gap-2 transition-all ${!loading ? 'hover:border-primary-blue/30 active:scale-95' : 'opacity-50'}`}
              >
                <Camera className="w-5 h-5 text-primary-blue" />
                <span className="text-xs font-bold text-ink/70">拍照</span>
              </button>
              <button 
                type="button"
                onClick={!loading ? handleGalleryUpload : undefined}
                disabled={loading}
                className={`h-24 bg-background rounded-3xl border border-divider flex flex-col items-center justify-center gap-2 transition-all ${!loading ? 'hover:border-primary-blue/30 active:scale-95' : 'opacity-50'}`}
              >
                <ImageIcon className="w-5 h-5 text-primary-blue" />
                <span className="text-xs font-bold text-ink/70">相簿上傳</span>
              </button>
            </div>
          </div>

          {photoUrls.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-4 px-2 snap-x">
              {photoUrls.map((url, idx) => (
                <div key={idx} className="relative shrink-0 snap-start">
                  <img src={url || undefined} alt={`Ref ${idx}`} className="w-32 h-32 object-cover rounded-2xl shadow-sm border border-divider" referrerPolicy="no-referrer" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const newUrls = [...photoUrls];
                      newUrls.splice(idx, 1);
                      setPhotoUrls(newUrls);
                      if (photoUrl === url) setPhotoUrl(newUrls.length > 0 ? newUrls[0] : '');
                    }}
                    className="absolute -top-2 -right-2 bg-red-500 text-white p-1.5 rounded-full shadow-md hover:bg-red-600 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Amount */}
          <div className="space-y-2 relative z-10">
            <label className="block text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">退稅金額 ({accounts.find(a => a.id === targetAccount)?.currency || '¥'})</label>
            <div className="relative">
              <span className="absolute left-6 top-1/2 -translate-y-1/2 text-primary-blue font-serif text-3xl font-bold">+</span>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full pl-16 pr-6 py-6 bg-background border border-divider rounded-[24px] text-4xl font-serif font-bold text-ink focus:ring-4 focus:ring-primary-blue/10 outline-none transition-all placeholder:text-ink/10"
                placeholder="0"
                required
              />
            </div>
          </div>

          {/* Target Account */}
          <div className="space-y-2 relative z-10">
            <label className="block text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">退稅領取帳戶 (現金/信用卡)</label>
            <select
              value={targetAccount}
              onChange={(e) => setTargetAccount(e.target.value)}
              className="w-full p-5 bg-background border border-divider rounded-[24px] focus:ring-4 focus:ring-primary-blue/10 outline-none appearance-none text-ink font-bold tracking-tight"
              required
            >
              <option value="" disabled>選擇領取帳戶</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.currency} {acc.balance.toLocaleString()})
                </option>
              ))}
            </select>
          </div>

          {/* Date */}
          <div className="space-y-2 relative z-10">
            <label className="block text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">退稅日期</label>
            <input
              type="datetime-local"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full p-5 bg-background border border-divider rounded-[24px] focus:ring-4 focus:ring-primary-blue/10 outline-none text-ink font-bold"
              required
            />
          </div>

          {/* Notes */}
          <div className="space-y-2 relative z-10">
            <label className="block text-[10px] font-bold text-ink/40 uppercase tracking-widest ml-4">備註 (選填)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full p-5 bg-background border border-divider rounded-[24px] focus:ring-4 focus:ring-primary-blue/10 outline-none text-ink font-medium"
              placeholder="例如：機場退稅"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || !amount || !targetAccount}
          className="w-full bg-ink text-white font-bold text-lg p-6 rounded-[24px] shadow-xl shadow-ink/20 hover:bg-ink/90 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Save className="w-5 h-5" />
          {loading ? '處理中...' : '儲存退稅紀錄'}
        </button>
      </form>
    </div>
  );
}
