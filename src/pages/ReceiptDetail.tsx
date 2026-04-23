import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, getDoc, setDoc, collection, query, deleteDoc, updateDoc, increment, orderBy, getDocs } from '../lib/local-db';
import { db, auth } from '../firebase';
import { handleFirestoreError, OperationType, getFriendlyErrorMessage } from '../lib/firestore-errors';
import { Camera, Save, Plus, Trash2, ArrowLeft, Image as ImageIcon, Sparkles, X, ClipboardPaste } from 'lucide-react';
import { format } from 'date-fns';
import { GoogleGenAI, Type } from '@google/genai';
import { Modal } from '../components/ui/Modal';
import { motion, AnimatePresence } from 'motion/react';
import { normalizeDate } from '../lib/utils';

const getAIClient = (apiKey: string) => {
  try {
    return new GoogleGenAI({ apiKey });
  } catch (e) {
    return null;
  }
};

const getAvailableKeys = () => {
  const keys: string[] = [];
  
  // 1. Check process.env (Vite often shims this or AI Studio injects it)
  if (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY);
  }

  // 2. Check import.meta.env (Standard Vite way)
  const metaKey = import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.GEMINI_API_KEY;
  if (metaKey) keys.push(metaKey);

  // 3. Add secondary keys 2-5
  // Note: Vite import.meta.env doesn't support dynamic keys like env[dynamic] easily in production
  // We explicitly check the expected names
  const k2 = import.meta.env.VITE_GEMINI_KEY_2;
  if (k2) keys.push(k2);
  const k3 = import.meta.env.VITE_GEMINI_KEY_3;
  if (k3) keys.push(k3);
  const k4 = import.meta.env.VITE_GEMINI_KEY_4;
  if (k4) keys.push(k4);
  const k5 = import.meta.env.VITE_GEMINI_KEY_5;
  if (k5) keys.push(k5);
  
  // Unique keys only
  return Array.from(new Set(keys)).filter(Boolean);
};

const compressImage = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1000;
        const MAX_HEIGHT = 1000;
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
        // Reset quality slightly lower to improve processing speed
        resolve(canvas.toDataURL('image/jpeg', 0.6));
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

export function ReceiptDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [accounts, setAccounts] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [pendingAiItems, setPendingAiItems] = useState<any[]>([]);
  
  const [receipt, setReceipt] = useState({
    date: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    totalAmount: 0,
    paymentAccountId: '',
    category: '進貨',
    subCategory: '飲食',
    currency: 'JPY',
    notes: '',
    photoUrl: '',
    photoUrls: [] as string[],
    storeName: ''
  });

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editItemData, setEditItemData] = useState({ name: '', translatedName: '', price: '', quantity: '', tag: '' });
  const [newItem, setNewItem] = useState({ name: '', translatedName: '', price: '', quantity: '1', notes: '', tag: '' });
  const [showFullImage, setShowFullImage] = useState(false);
  const [originalTotalAmount, setOriginalTotalAmount] = useState(0);
  const [originalAccountId, setOriginalAccountId] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

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

    const fetchAccounts = async () => {
      try {
        const snap = await getDocs(collection(db, `users/${auth.currentUser!.uid}/paymentAccounts`));
        const accountsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const sortedAccounts = accountsData.sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
        setAccounts(sortedAccounts);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `users/${auth.currentUser?.uid}/paymentAccounts`);
      }
    };

    fetchAccounts();
  }, []);

  useEffect(() => {
    if (isNew || !auth.currentUser || !id) return;

    const fetchReceiptAndItems = async () => {
      try {
        const docRef = doc(db, `users/${auth.currentUser!.uid}/receipts/${id}`);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          let displayDate = '';
          if (data.date) {
              if (data.date.includes('Z')) {
                 displayDate = format(new Date(data.date), "yyyy-MM-dd'T'HH:mm");
              } else {
                 displayDate = data.date.slice(0, 16);
              }
          }
          
          setReceipt({
            date: displayDate,
            totalAmount: data.totalAmount || 0,
            paymentAccountId: data.paymentAccountId || '',
            category: data.category || '進貨',
            subCategory: data.subCategory || '飲食',
            currency: data.currency || 'JPY',
            notes: data.notes || '',
            photoUrl: data.photoUrl || '',
            photoUrls: data.photoUrls || [],
            storeName: data.storeName || '',
            totalDiscount: data.totalDiscount || 0,
            totalTaxRefund: data.totalTaxRefund || 0
          });
          setOriginalTotalAmount(data.totalAmount);
          setOriginalAccountId(data.paymentAccountId);
        }

        const qItems = collection(db, `users/${auth.currentUser!.uid}/receipts/${id}/items`);
        const itemsSnap = await getDocs(qItems);
        const fetchedItems = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        fetchedItems.sort((a: any, b: any) => {
           const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
           const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
           return tB - tA;
        });
        setItems(fetchedItems);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `users/${auth.currentUser?.uid}/receipts/${id}`);
      }
    };

    fetchReceiptAndItems();
  }, [id, isNew]);

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (uploading || !auth.currentUser) return;
      
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        // Create a synthetic event object to reuse handleFileChange logic
        const syntheticEvent = {
          target: { files: imageFiles }
        } as unknown as React.ChangeEvent<HTMLInputElement>;
        
        await handleFileChange(syntheticEvent);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [uploading, auth.currentUser, receipt]); // Dependencies for handlePaste

  const handlePasteFromClipboard = async () => {
    if (uploading || !auth.currentUser) return;
    
    try {
      const clipboardItems = await navigator.clipboard.read();
      const imageFiles: File[] = [];
      for (const clipboardItem of clipboardItems) {
        for (const type of clipboardItem.types) {
          if (type.startsWith('image/')) {
            const blob = await clipboardItem.getType(type);
            const file = new File([blob], "pasted-image.png", { type });
            imageFiles.push(file);
          }
        }
      }
      
      if (imageFiles.length > 0) {
        const syntheticEvent = {
          target: { files: imageFiles }
        } as unknown as React.ChangeEvent<HTMLInputElement>;
        await handleFileChange(syntheticEvent);
      } else {
        setModalConfig({
          isOpen: true,
          title: '剪貼簿無圖片',
          message: '您的剪貼簿中沒有圖片，請先複製圖片後再試。',
          type: 'error'
        });
      }
    } catch (err) {
      console.error("Failed to read clipboard contents: ", err);
      setModalConfig({
        isOpen: true,
        title: '無法讀取剪貼簿',
        message: '請允許瀏覽器讀取剪貼簿權限，或直接使用鍵盤 Ctrl+V / Cmd+V 貼上。',
        type: 'error'
      });
    }
  };

  // Auto-calculate total from items if any exist
  useEffect(() => {
    if (items.length > 0 || pendingAiItems.length > 0) {
      const savedTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const pendingTotal = pendingAiItems.reduce((sum, item) => sum + ((item.price || 0) * (item.quantity || 1)), 0);
      setReceipt(prev => ({ ...prev, totalAmount: savedTotal + pendingTotal }));
    }
  }, [items, pendingAiItems]);

  const currencySymbol = receipt.currency || 'JPY';

  const handleSaveReceipt = async () => {
    if (!auth.currentUser || !receipt.paymentAccountId || !receipt.date) return;
    setLoading(true);

    try {
      const receiptId = isNew ? doc(collection(db, `users/${auth.currentUser.uid}/receipts`)).id : id!;
      const receiptRef = doc(db, `users/${auth.currentUser.uid}/receipts/${receiptId}`);
      
      const receiptData = {
        ...receipt,
        date: normalizeDate(receipt.date),
        totalAmount: Number(receipt.totalAmount),
        createdAt: isNew ? new Date().toISOString() : ((await getDoc(receiptRef).catch(() => null))?.data()?.createdAt || new Date().toISOString()),
        updatedAt: new Date().toISOString()
      };

      try {
        setDoc(receiptRef, receiptData).catch(error => {
            console.warn("Background sync failed or delayed", error);
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${auth.currentUser.uid}/receipts/${receiptId}`);
      }

      // Save pending items
      if (pendingAiItems.length > 0) {
        for (const item of pendingAiItems) {
          const itemRef = doc(collection(db, `users/${auth.currentUser.uid}/receipts/${receiptId}/items`));
          try {
            setDoc(itemRef, {
              name: item.name || 'Unknown Item',
              translatedName: item.translatedName || '',
              price: Number(item.price) || 0,
              quantity: Number(item.quantity) || 1,
              notes: item.notes || '',
              tag: item.tag || '',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }).catch(e => console.warn(e));
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `users/${auth.currentUser.uid}/receipts/${receiptId}/items`);
          }
        }
        setPendingAiItems([]);
      }

      // Update account balance
      if (isNew) {
        const accountRef = doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${receipt.paymentAccountId}`);
        try {
          updateDoc(accountRef, { balance: increment(-Number(receipt.totalAmount)) }).catch(e=>console.warn(e));
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, `users/${auth.currentUser.uid}/paymentAccounts/${receipt.paymentAccountId}`);
        }
      } else {
        // Handle changes in existing receipt
        const diff = Number(receipt.totalAmount) - originalTotalAmount;
        
        if (receipt.paymentAccountId === originalAccountId) {
          // Same account, just update the difference
          if (diff !== 0) {
            const accountRef = doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${receipt.paymentAccountId}`);
            try {
              updateDoc(accountRef, { balance: increment(-diff) }).catch(e=>console.warn(e));
            } catch (error) {
              handleFirestoreError(error, OperationType.UPDATE, `users/${auth.currentUser.uid}/paymentAccounts/${receipt.paymentAccountId}`);
            }
          }
        } else {
          // Account changed: restore old, deduct from new
          const oldAccountRef = doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${originalAccountId}`);
          const newAccountRef = doc(db, `users/${auth.currentUser.uid}/paymentAccounts/${receipt.paymentAccountId}`);
          
          try {
            updateDoc(oldAccountRef, { balance: increment(originalTotalAmount) }).catch(e=>console.warn(e));
            updateDoc(newAccountRef, { balance: increment(-Number(receipt.totalAmount)) }).catch(e=>console.warn(e));
          } catch (error) {
            handleFirestoreError(error, OperationType.UPDATE, `users/${auth.currentUser.uid}/paymentAccounts`);
          }
        }
        setOriginalTotalAmount(Number(receipt.totalAmount));
        setOriginalAccountId(receipt.paymentAccountId);
      }

      if (isNew) {
        navigate('/', { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    } catch (error: any) {
      console.error("Error saving receipt:", error);
      const friendlyMsg = getFriendlyErrorMessage(error);
      const isQuota = error.message?.includes('Quota') || error.message?.includes('exhausted') || (error.code === 'resource-exhausted');
      
      setModalConfig({
        isOpen: true,
        title: isQuota ? '⚠️ 雲端配額已滿' : '儲存失敗',
        message: isQuota 
          ? `Firestore 免費額度已用盡。請點擊首頁「設定」切換至「離線模式」，您目前仍可儲存至本地快取，待下午三點後再同步。`
          : `發生錯誤：${friendlyMsg}`,
        type: 'error'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser || !id) return;

    if (isNew) {
      setPendingAiItems(prev => [{
        name: newItem.name,
        translatedName: newItem.translatedName,
        price: Number(newItem.price),
        quantity: Number(newItem.quantity),
        notes: newItem.notes,
        tag: newItem.tag,
        createdAt: new Date().toISOString() // Useful for consistency even if pending
      }, ...prev]);
      setNewItem({ name: '', translatedName: '', price: '', quantity: '1', notes: '', tag: '' });
      return;
    }

    const itemRef = doc(collection(db, `users/${auth.currentUser.uid}/receipts/${id}/items`));
    try {
      await setDoc(itemRef, {
        name: newItem.name,
        translatedName: newItem.translatedName,
        price: Number(newItem.price),
        quantity: Number(newItem.quantity),
        notes: newItem.notes,
        tag: newItem.tag || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${auth.currentUser.uid}/receipts/${id}/items`);
    }

    setNewItem({ name: '', translatedName: '', price: '', quantity: '1', notes: '', tag: '' });
  };

  const handleUpdateItem = async (itemId: string, isPending: boolean = false, pendingIndex?: number) => {
    if (isPending && pendingIndex !== undefined) {
      setPendingAiItems(prev => {
        const updated = [...prev];
        updated[pendingIndex] = {
          ...updated[pendingIndex],
          name: editItemData.name,
          translatedName: editItemData.translatedName,
          price: Number(editItemData.price),
          quantity: Number(editItemData.quantity),
          tag: editItemData.tag || ''
        };
        return updated;
      });
      setEditingItemId(null);
      return;
    }

    if (!auth.currentUser || !id) return;
    const itemRef = doc(db, `users/${auth.currentUser.uid}/receipts/${id}/items/${itemId}`);
    try {
      updateDoc(itemRef, {
        name: editItemData.name,
        translatedName: editItemData.translatedName,
        price: Number(editItemData.price),
        quantity: Number(editItemData.quantity),
        tag: editItemData.tag || ''
      }).catch(e=>console.warn(e));
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${auth.currentUser.uid}/receipts/${id}/items/${itemId}`);
    }
    setEditingItemId(null);
  };

  const startEditing = (item: any, isPending: boolean = false, pendingIndex?: number) => {
    setEditingItemId(isPending ? `pending-${pendingIndex}` : item.id);
    setEditItemData({
      name: item.name,
      translatedName: item.translatedName || '',
      price: item.price.toString(),
      quantity: item.quantity.toString(),
      tag: item.tag || ''
    });
  };

  const handleDeleteItem = async (itemId: string, isPending: boolean = false, pendingIndex?: number) => {
    if (isPending && pendingIndex !== undefined) {
       setPendingAiItems(prev => prev.filter((_, i) => i !== pendingIndex));
       return;
    }

    if (!auth.currentUser || !id) return;
    setModalConfig({
      isOpen: true,
      title: '確認刪除',
      message: '確定要刪除此項目嗎？',
      type: 'confirm',
      onConfirm: async () => {
        const itemRef = doc(db, `users/${auth.currentUser!.uid}/receipts/${id}/items/${itemId}`);
        try {
          await deleteDoc(itemRef);
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `users/${auth.currentUser?.uid}/receipts/${id}/items/${itemId}`);
        }
      }
    });
  };

  const handlePhotoUpload = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleGalleryUpload = () => {
    if (galleryInputRef.current) {
      galleryInputRef.current.click();
    }
  };

  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [currentKeyIndex, setCurrentKeyIndex] = useState(0);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !auth.currentUser) return;

    setUploading(true);
    setUploadProgress(10);
    setUploadStatus(`壓縮 ${files.length} 張照片中...`);

    const availableKeys = getAvailableKeys();
    if (availableKeys.length === 0) {
      setUploading(false);
      setModalConfig({
        isOpen: true,
        title: '缺少 API 金鑰',
        message: '請至應用程式設定 (Settings -> Secrets) 綁定 VITE_GEMINI_KEY_2 ~ 5。目前找不到任何有效的 AI 辨識金鑰。',
        type: 'error'
      });
      return;
    }
    
    let retryCount = 0;
    const maxRetries = availableKeys.length;

    const performOCR = async (keyIndex: number): Promise<any> => {
      try {
        const compressedDataUrls = await Promise.all(files.map((file: File) => compressImage(file)));
        
        setUploadProgress(30);
        setUploadStatus(`AI 辨識中 (金鑰池 #${keyIndex + 1})...`);

        const parts: any[] = compressedDataUrls.map(dataUrl => {
          const base64Data = dataUrl.split(',')[1];
          const mimeType = dataUrl.split(';')[0].split(':')[1];
          return {
            inlineData: {
              data: base64Data,
              mimeType: mimeType
            }
          };
        });

        const prompt = `
          [角色任務]：你是一位世界頂級的財務數據提取專家，專精於從複雜的收據、發票照片中精確擷取資訊。
          
          [提取指令]：
          1. 商店名稱 (storeName)：擷取收據上的商店全名。
          2. 總金額 (totalAmount)：擷取收據最終支付的實付總額。
          3. 【⚠️ 極致嚴謹：日期時間格式 ⚠️】：
             - **當前年份參考**：現在是 2026 年，若收據年份模糊，請以 2026 進行邏輯推斷。
             - **格式唯一標準**：必須為 YYYY-MM-DDTHH:mm (例如 2026-04-22T14:30)。
             - **絕對禁止空格**：日期與時間之間禁止使用空格（Space），必須使用大寫 'T'。
             - **絕對禁止非法點/斜線**：禁止使用 2026.04.22 或 2026/04/22，必須使用連字號 '-'。
             - **補位要求**：月份、日期、小時、分鐘若為個位數，必須補 0（例如：04 而不是 4）。
             - **缺漏處理**：若收據無詳細時間，請強制填寫 T00:00。
             - **重要性**：這是系統排序的唯一依據，任何格式偏差（尤其是空格）都會導致排序失效，請執行最高精細度的校對。
          4. 購買項目 (items)：
             - 保留原文名稱 (name)。
             - 提供精確的「繁體中文」翻譯 (translatedName)。
             - 擷取單價 (price) 與數量 (quantity)。
          5. 特殊項處理：
             - 折扣 (Discount/值引/クーポン)：作為 item 獨立列出，單價必須為「負數」。
             - 外加稅金/服務費 (Tax/Service Fee)：若收據是稅外加，請將稅額、小費等作為獨立 item 列出，確保 totalAmount = 所有 items 的總和。
          
          [計算校驗]：
          - 請自行加總所有 items 的 (單價 * 數量)，其結果必須精準等於 totalAmount。
          - 辨識語系：繁體中文翻譯。
        `;

        parts.push({ text: prompt });

        const activeAi = getAIClient(availableKeys[keyIndex]);
        if (!activeAi) throw new Error("API Key Invalid");

        const response = await activeAi.models.generateContent({
          model: 'gemini-3-flash-preview', // Upgraded to Gemini 3 series engine
          contents: [{ parts }],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                storeName: { type: Type.STRING },
                date: { 
                  type: Type.STRING, 
                  description: "Standardized date string: YYYY-MM-DDTHH:mm (NO SPACES, must use T separator)" 
                },
                totalAmount: { type: Type.NUMBER },
                totalDiscount: { type: Type.NUMBER },
                totalTaxRefund: { type: Type.NUMBER },
                items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      translatedName: { type: Type.STRING },
                      price: { type: Type.NUMBER },
                      quantity: { type: Type.NUMBER }
                    }
                  }
                }
              }
            }
          }
        });

        const result = JSON.parse(response.text || '{}');
        // 自動執行數據清洗 (Data Wash)：即便 AI 給出了空格，系統也會在存檔前強制校準
        if (result.date) {
          result.date = normalizeDate(result.date);
        }
        return { result, compressedDataUrls };

      } catch (error: any) {
        console.error(`Gemini OCR Error (Key #${keyIndex + 1}):`, error);
        const isQuota = error.message?.includes('429') || error.message?.includes('exhausted') || error.message?.includes('Quota');
        const friendlyMsg = getFriendlyErrorMessage(error);
        
        if (isQuota && retryCount < maxRetries - 1) {
          console.warn(`Gemini Key #${keyIndex + 1} exhausted, rotating key...`);
          retryCount++;
          const nextIndex = (keyIndex + 1) % availableKeys.length;
          setCurrentKeyIndex(nextIndex);
          setUploadStatus(`金鑰 #${keyIndex + 1} 滿載，自動切換至備用金鑰 #${nextIndex + 1}...`);
          return performOCR(nextIndex);
        }

        // 如果所有金鑰都用完或是其他 AI 錯誤
        if (isQuota) {
          throw new Error(`AI 辨識配額已用盡。原因：${friendlyMsg}。建議您先手動輸入，或待數小時後再試。`);
        }
        throw new Error(`AI 辨識失敗：${friendlyMsg}`);
      }
    };

    try {
      const { result, compressedDataUrls } = await performOCR(currentKeyIndex);
      
      setUploadProgress(90);
      setUploadStatus('處理資料中...');

      const newReceiptData = {
        ...receipt,
        photoUrl: compressedDataUrls[0],
        photoUrls: compressedDataUrls,
        storeName: result.storeName || receipt.storeName,
        totalAmount: result.totalAmount || receipt.totalAmount,
        date: result.date ? normalizeDate(result.date).slice(0, 16) : receipt.date,
        totalDiscount: result.totalDiscount || 0,
        totalTaxRefund: result.totalTaxRefund || 0
      };

      setReceipt(newReceiptData);

      if (result.items && result.items.length > 0) {
        const newItems = result.items.map((item: any) => ({
          name: item.name || 'Unknown Item',
          translatedName: item.translatedName || '',
          price: Number(item.price) || 0,
          quantity: Number(item.quantity) || 1,
          notes: 'AI 自動辨識'
        }));
        setPendingAiItems(prev => [...newItems, ...prev]);
      }
      
      setModalConfig({
        isOpen: true,
        title: '辨識完成',
        message: 'AI 已成功辨識單據資訊！請確認明細後點擊「儲存單據」。',
        type: 'success'
      });

    } catch (error: any) {
      console.error("Error processing receipt:", error);
      
      let errorMessage = '照片處理或 AI 辨識發生錯誤，請重試。';
      
      // Check for specific AI errors
      if (error?.message?.includes('429') || error?.message?.includes('Resource has been exhausted')) {
        errorMessage = '辨識失敗：所有可用 AI 金鑰的額度都已用盡或受到限制。請稍候幾分鐘再試，或明天再刷新額度。';
      } else if (error?.message?.includes('Safety') || error?.message?.includes('blocked')) {
        errorMessage = '辨識失敗：照片內容被 AI 安全過濾器攔截。請嘗試換一張更清晰的照片。';
      } else if (error?.message?.includes('parse') || error?.message?.includes('JSON')) {
        errorMessage = '辨識失敗：AI 回傳格式錯誤。請再試一次。';
      }

      setModalConfig({
        isOpen: true,
        title: '辨識發生錯誤',
        message: errorMessage,
        type: 'error'
      });
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadStatus('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (galleryInputRef.current) galleryInputRef.current.value = '';
    }
  };

  return (
    <div className="p-4 max-w-md mx-auto pb-24 bg-background min-h-screen">
      <header className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-3 bg-white rounded-2xl shadow-md hover:shadow-lg transition-all active:scale-95 group">
          <ArrowLeft className="w-5 h-5 text-ink group-hover:text-primary-blue transition-colors" />
        </button>
        <div>
          <h1 className="text-2xl font-serif font-black text-ink tracking-tight uppercase">{isNew ? '新增單據' : '單據詳情'}</h1>
          <p className="text-[10px] font-bold text-ink/30 uppercase tracking-[0.2em]">{isNew ? 'New Entry' : 'Edit Transaction'}</p>
        </div>
      </header>

      <div className="space-y-6">
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

        {isNew && (
          <div className="bg-card-white text-ink text-sm p-6 rounded-[32px] border border-divider shadow-xl shadow-black/[0.02] flex items-start gap-4 relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary-blue/5 rounded-full -mr-12 -mt-12 group-hover:scale-110 transition-transform duration-700" />
            <div className="bg-primary-blue p-3 rounded-2xl shadow-lg shadow-primary-blue/20 relative z-10">
              <Sparkles className="w-6 h-6 text-white shrink-0" />
            </div>
            <div className="flex-1 relative z-10">
              <p className="font-serif font-black text-ink text-xl mb-1 uppercase tracking-tight">AI 智慧解析</p>
              <p className="text-ink/60 leading-relaxed font-medium text-xs">
                只需拍照，AI 將自動精準辨識商店名稱、日期、金額與明細，讓記帳變得毫不費力。
              </p>
            </div>
          </div>
        )}

        {/* Photo Section */}
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <button 
              onClick={!uploading ? handlePhotoUpload : undefined}
              disabled={uploading}
              className={`w-full h-32 bg-card-white rounded-[28px] border-2 border-transparent flex flex-col items-center justify-center overflow-hidden relative group shadow-lg shadow-black/[0.03] transition-all ${!uploading ? 'cursor-pointer hover:border-primary-blue hover:shadow-primary-blue/10 active:scale-95' : 'opacity-50'}`}
            >
              <div className="bg-primary-blue/5 p-3 rounded-2xl mb-2 group-hover:bg-primary-blue/10 transition-colors">
                <Camera className="w-6 h-6 text-primary-blue" />
              </div>
              <span className="text-xs font-bold text-ink uppercase tracking-widest">拍照</span>
            </button>
            <button 
              onClick={!uploading ? handleGalleryUpload : undefined}
              disabled={uploading}
              className={`w-full h-32 bg-card-white rounded-[28px] border-2 border-transparent flex flex-col items-center justify-center overflow-hidden relative group shadow-lg shadow-black/[0.03] transition-all ${!uploading ? 'cursor-pointer hover:border-primary-blue hover:shadow-primary-blue/10 active:scale-95' : 'opacity-50'}`}
            >
              <div className="bg-primary-blue/5 p-3 rounded-2xl mb-2 group-hover:bg-primary-blue/10 transition-colors">
                <ImageIcon className="w-6 h-6 text-primary-blue" />
              </div>
              <span className="text-xs font-bold text-ink uppercase tracking-widest">相簿</span>
            </button>
            <button 
              onClick={!uploading ? handlePasteFromClipboard : undefined}
              disabled={uploading}
              className={`w-full h-32 bg-card-white rounded-[28px] border-2 border-transparent flex flex-col items-center justify-center overflow-hidden relative group shadow-lg shadow-black/[0.03] transition-all ${!uploading ? 'cursor-pointer hover:border-primary-blue hover:shadow-primary-blue/10 active:scale-95' : 'opacity-50'}`}
            >
              <div className="bg-primary-blue/5 p-3 rounded-2xl mb-2 group-hover:bg-primary-blue/10 transition-colors">
                <ClipboardPaste className="w-6 h-6 text-primary-blue" />
              </div>
              <span className="text-xs font-bold text-ink uppercase tracking-widest">貼上</span>
            </button>
          </div>
          
          {!uploading && (
            <div className="text-center text-[10px] font-bold text-ink/40 uppercase tracking-widest mt-2">
              💡 提示：您也可以直接在此頁面貼上 (Ctrl+V / Cmd+V) 截圖或複製的圖片
            </div>
          )}

          {uploading && (
            <div className="w-full h-48 bg-background rounded-3xl border-2 border-dashed border-divider flex flex-col items-center justify-center overflow-hidden relative">
              <div className="flex flex-col items-center justify-center w-full h-full bg-ink/80 text-white z-10 absolute inset-0 px-6">
                <div className="w-16 h-16 border-4 border-white/20 border-t-white rounded-full animate-spin mb-4"></div>
                <span className="font-bold text-sm mb-2 tracking-widest">{uploadStatus || '處理中...'}</span>
                <div className="w-full max-w-[200px] bg-white/20 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-primary-blue h-full transition-all duration-300 ease-out" 
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {receipt.photoUrls && receipt.photoUrls.length > 0 && !uploading && (
            <div className="flex gap-4 overflow-x-auto pb-2 snap-x">
              {receipt.photoUrls.map((url, idx) => (
                <div 
                  key={idx}
                  className="min-w-[80%] h-48 bg-background rounded-3xl border-2 border-dashed border-divider flex-shrink-0 flex flex-col items-center justify-center overflow-hidden relative group cursor-pointer snap-center"
                  onClick={() => setShowFullImage(true)} // Note: currently just shows the first image in full screen, could be improved to show a specific one
                >
                  <img src={url || undefined} alt={`Receipt ${idx + 1}`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  <div className="absolute inset-0 bg-ink/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Sparkles className="w-8 h-8 text-white" />
                    <span className="text-white font-bold ml-2">點擊放大</span>
                  </div>
                  <div className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-full font-bold">
                    {idx + 1} / {receipt.photoUrls.length}
                  </div>
                </div>
              ))}
            </div>
          )}
          {receipt.photoUrl && (!receipt.photoUrls || receipt.photoUrls.length === 0) && !uploading && (
            <div 
              className="w-full h-48 bg-background rounded-3xl border-2 border-dashed border-divider flex flex-col items-center justify-center overflow-hidden relative group cursor-pointer"
              onClick={() => setShowFullImage(true)}
            >
              <img src={receipt.photoUrl || undefined} alt="Receipt" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              <div className="absolute inset-0 bg-ink/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-white" />
                <span className="text-white font-bold ml-2">點擊放大</span>
              </div>
            </div>
          )}
        </div>

        {/* Full Screen Image Modal */}
        <AnimatePresence>
          {showFullImage && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4"
              onClick={() => setShowFullImage(false)}
            >
              <motion.img 
                initial={{ scale: 0.9 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.9 }}
                src={receipt.photoUrl || undefined} 
                className="max-w-full max-h-full object-contain rounded-xl"
                alt="Full Receipt"
              />
              <button className="absolute top-6 right-6 text-white p-2 bg-white/10 rounded-full">
                <X className="w-6 h-6" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Items Section */}
        <div className="bg-card-white p-6 rounded-3xl shadow-sm border border-divider space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-serif font-bold text-ink">單據明細</h2>
            <span className="text-[10px] font-bold text-ink/30 uppercase tracking-widest">Items</span>
          </div>
          
          <div className="space-y-3">
            {pendingAiItems.map((item, idx) => {
              const rowId = `pending-${idx}`;
              return (
              <div key={rowId} className="p-4 bg-primary-blue/5 rounded-2xl border border-primary-blue/20">
                {editingItemId === rowId ? (
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={editItemData.name}
                      onChange={e => setEditItemData({...editItemData, name: e.target.value})}
                      className="w-full p-2 bg-white border border-divider rounded-xl outline-none text-ink font-bold"
                      placeholder="原文名稱"
                    />
                    <input
                      type="text"
                      value={editItemData.translatedName}
                      onChange={e => setEditItemData({...editItemData, translatedName: e.target.value})}
                      className="w-full p-2 bg-white border border-divider rounded-xl outline-none text-ink/60 text-xs"
                      placeholder="中文翻譯"
                    />
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={editItemData.price}
                        onChange={e => setEditItemData({...editItemData, price: e.target.value})}
                        className="flex-1 p-2 bg-white border border-divider rounded-xl outline-none text-ink font-bold"
                        placeholder="單價"
                      />
                      <input
                        type="number"
                        value={editItemData.quantity}
                        onChange={e => setEditItemData({...editItemData, quantity: e.target.value})}
                        className="w-20 p-2 bg-white border border-divider rounded-xl outline-none text-ink font-bold text-center"
                        placeholder="數量"
                      />
                    </div>
                    <select
                      value={editItemData.tag}
                      onChange={e => setEditItemData({...editItemData, tag: e.target.value})}
                      className="w-full p-2 bg-white border border-divider rounded-xl outline-none text-ink text-sm appearance-none"
                    >
                      <option value="">用途：預設</option>
                      <option value="私人">私人</option>
                      <option value="送禮">送禮</option>
                    </select>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => handleUpdateItem('', true, idx)}
                        className="flex-1 bg-primary-blue text-white font-bold py-2 rounded-xl text-xs"
                      >
                        儲存
                      </button>
                      <button 
                        onClick={() => setEditingItemId(null)}
                        className="flex-1 bg-ink/10 text-ink font-bold py-2 rounded-xl text-xs"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-center">
                    <div className="cursor-pointer flex-1" onClick={() => startEditing(item, true, idx)}>
                      <p className="font-bold text-ink flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-primary-blue" />
                        {item.name}
                        {item.tag && <span className="px-2 py-0.5 bg-red-100 text-red-600 rounded-lg text-[10px] font-bold ml-2">{item.tag}</span>}
                      </p>
                      {item.translatedName && (
                        <p className="text-[10px] font-bold text-ink/40 mb-1 ml-4">{item.translatedName}</p>
                      )}
                      <p className="text-[10px] font-bold text-primary-blue/70 uppercase tracking-wider">{currencySymbol} {item.price} x {item.quantity} (待儲存)</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-serif font-bold text-ink">{currencySymbol} {((item.price * item.quantity) || 0).toLocaleString()}</span>
                      <button onClick={() => handleDeleteItem('', true, idx)} className="text-red-400 p-1 hover:bg-red-50 rounded-lg transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )})}

            {items.map(item => (
              <div key={item.id} className="p-4 bg-background rounded-2xl border border-divider">
                {editingItemId === item.id ? (
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={editItemData.name}
                      onChange={e => setEditItemData({...editItemData, name: e.target.value})}
                      className="w-full p-2 bg-white border border-divider rounded-xl outline-none text-ink font-bold"
                      placeholder="原文名稱"
                    />
                    <input
                      type="text"
                      value={editItemData.translatedName}
                      onChange={e => setEditItemData({...editItemData, translatedName: e.target.value})}
                      className="w-full p-2 bg-white border border-divider rounded-xl outline-none text-ink/60 text-xs"
                      placeholder="中文翻譯"
                    />
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={editItemData.price}
                        onChange={e => setEditItemData({...editItemData, price: e.target.value})}
                        className="flex-1 p-2 bg-white border border-divider rounded-xl outline-none text-ink font-bold"
                        placeholder="單價"
                      />
                      <input
                        type="number"
                        value={editItemData.quantity}
                        onChange={e => setEditItemData({...editItemData, quantity: e.target.value})}
                        className="w-20 p-2 bg-white border border-divider rounded-xl outline-none text-ink font-bold text-center"
                        placeholder="數量"
                      />
                    </div>
                    <select
                      value={editItemData.tag}
                      onChange={e => setEditItemData({...editItemData, tag: e.target.value})}
                      className="w-full p-2 bg-white border border-divider rounded-xl outline-none text-ink text-sm appearance-none"
                    >
                      <option value="">用途：預設</option>
                      <option value="私人">私人</option>
                      <option value="送禮">送禮</option>
                    </select>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => handleUpdateItem(item.id)}
                        className="flex-1 bg-primary-blue text-white font-bold py-2 rounded-xl text-xs"
                      >
                        儲存
                      </button>
                      <button 
                        onClick={() => setEditingItemId(null)}
                        className="flex-1 bg-ink/10 text-ink font-bold py-2 rounded-xl text-xs"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-center">
                    <div className="cursor-pointer flex-1" onClick={() => startEditing(item)}>
                      <p className="font-bold text-ink flex items-center gap-2">
                        {item.name}
                        {item.tag && <span className="px-2 py-0.5 bg-red-100 text-red-600 rounded-lg text-[10px] font-bold">{item.tag}</span>}
                      </p>
                      {item.translatedName && (
                        <p className="text-[10px] font-bold text-ink/40 mb-1">{item.translatedName}</p>
                      )}
                      <p className="text-[10px] font-bold text-ink/50 uppercase tracking-wider">{currencySymbol} {item.price} x {item.quantity}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-serif font-bold text-ink">{currencySymbol} {(item.price * item.quantity).toLocaleString()}</span>
                      <button onClick={() => handleDeleteItem(item.id)} className="text-red-400 p-1 hover:bg-red-50 rounded-lg transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <form onSubmit={handleAddItem} className="pt-6 border-t border-divider space-y-4">
            <div className="space-y-2">
              <input
                type="text"
                placeholder="品名 (原文)"
                value={newItem.name}
                onChange={e => setNewItem({...newItem, name: e.target.value})}
                className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink placeholder:text-ink/30"
                required
              />
              <input
                type="text"
                placeholder="中文翻譯 (選填)"
                value={newItem.translatedName}
                onChange={e => setNewItem({...newItem, translatedName: e.target.value})}
                className="w-full p-3 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none text-sm text-ink/60 placeholder:text-ink/20"
              />
            </div>
            <div className="flex gap-4">
              <input
                type="number"
                placeholder={`單價 (${currencySymbol})`}
                value={newItem.price}
                onChange={e => setNewItem({...newItem, price: e.target.value})}
                className="flex-1 p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink placeholder:text-ink/30"
                required
              />
              <input
                type="number"
                placeholder="數量"
                value={newItem.quantity}
                onChange={e => setNewItem({...newItem, quantity: e.target.value})}
                className="w-24 p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink placeholder:text-ink/30 text-center"
                required
                min="1"
              />
            </div>
            <select
              value={newItem.tag}
              onChange={e => setNewItem({...newItem, tag: e.target.value})}
              className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none text-ink font-bold appearance-none"
            >
              <option value="">用途：預設</option>
              <option value="私人">私人</option>
              <option value="送禮">送禮</option>
            </select>
            <button type="submit" className="w-full bg-ink text-white font-bold p-4 rounded-2xl hover:opacity-90 flex items-center justify-center gap-2 transition-all active:scale-95">
              <Plus className="w-5 h-5" />
              新增明細
            </button>
          </form>
        </div>

        {/* Basic Info Form (Payment Section) */}
        <div className="bg-card-white p-6 rounded-3xl shadow-sm border border-divider space-y-6">
          <h2 className="text-lg font-serif font-bold text-ink">基本資訊</h2>
          
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">商店名稱</label>
              <input
                type="text"
                placeholder="例如：7-11, 餐廳名稱"
                value={receipt.storeName || ''}
                onChange={e => setReceipt({...receipt, storeName: e.target.value})}
                className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink text-sm"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">日期時間</label>
              <input
                type="datetime-local"
                value={receipt.date}
                onChange={e => setReceipt({...receipt, date: e.target.value})}
                className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink text-xs"
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-1">
                <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">幣別</label>
                <select
                  value={receipt.currency || 'JPY'}
                  onChange={e => setReceipt({...receipt, currency: e.target.value})}
                  disabled={items.length > 0 || pendingAiItems.length > 0}
                  className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink appearance-none disabled:opacity-50"
                >
                  <option value="JPY">JPY</option>
                  <option value="TWD">TWD</option>
                  <option value="KRW">KRW</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">總金額</label>
                <input
                  type="number"
                  value={receipt.totalAmount}
                  onChange={e => setReceipt({...receipt, totalAmount: Number(e.target.value)})}
                  disabled={items.length > 0 || pendingAiItems.length > 0}
                  className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none disabled:opacity-50 font-serif font-bold text-ink text-lg"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">總折扣 (選填)</label>
                <input
                  type="number"
                  value={receipt.totalDiscount || ''}
                  onChange={e => setReceipt({...receipt, totalDiscount: Number(e.target.value)})}
                  className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-serif font-bold text-green-600 text-sm"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">總退稅 (選填)</label>
                <input
                  type="number"
                  value={receipt.totalTaxRefund || ''}
                  onChange={e => setReceipt({...receipt, totalTaxRefund: Number(e.target.value)})}
                  className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-serif font-bold text-blue-600 text-sm"
                  placeholder="0"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">支付方式 <span className="text-red-400">*</span></label>
            <select
              value={receipt.paymentAccountId}
              onChange={e => setReceipt({...receipt, paymentAccountId: e.target.value})}
              className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink appearance-none"
            >
              <option value="">選擇支付帳戶</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name} ({a.currency} {a.balance.toLocaleString()})</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">支出類別</label>
              <select
                value={receipt.category}
                onChange={e => setReceipt({...receipt, category: e.target.value})}
                className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink appearance-none"
              >
                <option value="進貨">進貨</option>
                <option value="私人">私人</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-ink/40 mb-1.5 uppercase tracking-widest">子類別</label>
              <input
                list="sub-categories"
                value={receipt.subCategory}
                onChange={e => setReceipt({...receipt, subCategory: e.target.value})}
                className="w-full p-4 bg-background border border-divider rounded-2xl focus:ring-2 focus:ring-primary-blue outline-none font-bold text-ink"
                placeholder="輸入或選擇類別"
              />
              <datalist id="sub-categories">
                {(receipt.category === 'Personal' || receipt.category === '私人') 
                  ? ['飲食', '服飾', '居住', '交通', '教育', '娛樂', '其他'].map(cat => <option key={cat} value={cat} />)
                  : ['商品成本', '交通', '住宿', '餐飲', '雜支', '其他'].map(cat => <option key={cat} value={cat} />)
                }
              </datalist>
            </div>
          </div>

          <button
            onClick={handleSaveReceipt}
            disabled={loading || !receipt.paymentAccountId}
            className="w-full bg-primary-blue text-white font-bold p-5 rounded-3xl shadow-lg shadow-primary-blue/20 hover:opacity-90 transition-all flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95"
          >
            <Save className="w-5 h-5" />
            {isNew ? '確認並儲存單據' : '儲存單據變更'}
          </button>
        </div>
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
