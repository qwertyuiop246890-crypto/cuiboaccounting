import React, { Component, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged } from './lib/local-db';
import { doc, getDoc, setDoc, getDocFromCache as getDocFromServer } from './lib/local-db';
import { auth, db } from './firebase';
import { Home } from './pages/Home';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { ReceiptDetail } from './pages/ReceiptDetail';
import { Transfer } from './pages/Transfer';
import { TaxRefund } from './pages/TaxRefund';
import { Layout } from './components/Layout';
import { Loader2, AlertCircle } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { hasError: false, error: null };
  public props: ErrorBoundaryProps;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.props = props;
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "發生了錯誤，請稍後再試。";
      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed.error) errorMessage = `權限錯誤: ${parsed.operationType} ${parsed.path || ''}`;
      } catch (e) {}

      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
          <div className="max-w-md w-full bg-card-white p-8 rounded-[40px] shadow-xl border border-divider text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-serif font-bold text-ink mb-4">糟糕！出錯了</h2>
            <p className="text-ink/60 mb-8">{errorMessage}</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-primary-blue text-white px-8 py-3 rounded-2xl font-bold hover:opacity-90 transition-all"
            >
              重新整理
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubscribe = () => {};
    try {
      unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
        if (currentUser) {
          try {
            // Ensure user document exists
            const userDocRef = doc(db, 'users', currentUser.uid);
            const userDoc = await getDoc(userDocRef);
            if (!userDoc.exists()) {
              await setDoc(userDocRef, {
                email: currentUser.email,
                displayName: currentUser.displayName,
                photoURL: currentUser.photoURL,
                role: 'client',
                createdAt: new Date().toISOString()
              });
            }
          } catch (e) {
            console.log("Could not fetch or create user doc, proceeding with cached auth", e);
          }
        }
        setUser(currentUser);
        setLoading(false);
      });
    } catch (e) {
        console.error("Auth listener failed", e);
        setLoading(false);
    }
    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary-blue" />
      </div>
    );
  }

  if (!user) {
    // Should never happen with local mock, but just in case
    return null;
  }

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="settings" element={<Settings />} />
            <Route path="receipt/:id" element={<ReceiptDetail />} />
            <Route path="transfer" element={<Transfer />} />
            <Route path="tax-refund" element={<TaxRefund />} />
            <Route path="tax-refund/:id" element={<TaxRefund />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
