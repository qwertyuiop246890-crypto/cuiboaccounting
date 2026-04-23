import React from 'react';
import { X, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title: string;
  message: string;
  type?: 'info' | 'success' | 'error' | 'confirm';
  confirmText?: string;
  cancelText?: string;
}

export function Modal({ 
  isOpen, 
  onClose, 
  onConfirm, 
  title, 
  message, 
  type = 'info',
  confirmText = '確定',
  cancelText = '取消'
}: ModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="relative w-full max-w-sm bg-card-white rounded-[32px] shadow-2xl overflow-hidden border border-divider"
          >
            <div className="p-8">
              <div className="flex flex-col items-center text-center gap-4 mb-6">
                <div className={`p-4 rounded-3xl ${
                  type === 'success' ? 'bg-primary-blue/10 text-primary-blue' :
                  type === 'error' ? 'bg-red-50 text-red-400' :
                  type === 'confirm' ? 'bg-ink/10 text-ink' :
                  'bg-primary-blue/10 text-primary-blue'
                }`}>
                  {type === 'success' && <CheckCircle2 className="w-8 h-8" />}
                  {type === 'error' && <AlertCircle className="w-8 h-8" />}
                  {type === 'confirm' && <AlertCircle className="w-8 h-8" />}
                  {type === 'info' && <Info className="w-8 h-8" />}
                </div>
                <h3 className="text-2xl font-serif font-bold text-ink">{title}</h3>
              </div>
              
              <p className="text-ink/70 leading-relaxed mb-8 text-center font-medium">
                {message}
              </p>

              <div className="flex gap-3">
                {type === 'confirm' && (
                  <button
                    onClick={onClose}
                    className="flex-1 px-4 py-4 bg-background text-ink font-bold rounded-2xl hover:bg-ink/5 transition-colors"
                  >
                    {cancelText}
                  </button>
                )}
                <button
                  onClick={() => {
                    if (onConfirm) {
                      onConfirm();
                    } else {
                      onClose();
                    }
                  }}
                  className={`flex-1 px-4 py-4 text-white font-bold rounded-2xl transition-all active:scale-95 shadow-lg ${
                    type === 'error' ? 'bg-red-400 shadow-red-100' :
                    type === 'confirm' ? 'bg-ink shadow-ink/10' :
                    'bg-primary-blue shadow-primary-blue/20'
                  }`}
                >
                  {confirmText}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
