import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const normalizeDate = (dateStr: string) => {
  if (!dateStr) return '';
  
  // 1. 基本清理：移除頭尾空格，處理斜線與點
  let cleaned = dateStr.trim();
  
  // 處理 AI 可能產生的多餘空格，例如 "2024 / 4 / 20" -> "2024-4-20"
  cleaned = cleaned.replace(/\s*[\/\.]\s*/g, '-');
  
  // 處理日期與時間之間的空格：確保只剩下一個空格
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  // 特殊處理：如果是 "YYYY-MM-DD HH:mm" 格式，轉換中間的空格為 'T'
  if (/^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2}/.test(cleaned)) {
    cleaned = cleaned.replace(' ', 'T');
  } else if (cleaned.includes(' ') && !cleaned.includes('T')) {
    // 泛用處理：如果只有一個空格且沒有 T，嘗試替換
    cleaned = cleaned.replace(' ', 'T');
  }

  try {
    const [datePart, timePart] = cleaned.split('T');
    const dateBits = datePart.split('-').map(b => b.trim());
    
    // 獲取當前年份作為缺省值
    const currentYear = new Date().getFullYear();
    let y = currentYear.toString();
    let m = '01';
    let d = '01';

    if (dateBits.length === 3) {
      // YYYY-MM-DD
      [y, m, d] = dateBits;
      if (y.length === 2) y = `20${y}`;
    } else if (dateBits.length === 2) {
      // MM-DD (假設為今年)
      [m, d] = dateBits;
    } else {
      // 無法識別格式，回傳原始清理後的字串
      return cleaned;
    }

    // 補 0 處理
    m = m.padStart(2, '0');
    d = d.padStart(2, '0');
    
    let finalTime = '00:00';
    if (timePart) {
      const timeSegments = timePart.split(':').map(s => s.trim());
      const hh = (timeSegments[0] || '00').padStart(2, '0').slice(0, 2);
      const mm = (timeSegments[1] || '00').padStart(2, '0').slice(0, 2);
      finalTime = `${hh}:${mm}`;
    }

    return `${y}-${m}-${d}T${finalTime}`;
  } catch (e) {
    console.warn("Date normalization failed", e);
  }
  return cleaned;
};
