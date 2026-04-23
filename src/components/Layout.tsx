import { Outlet, NavLink } from 'react-router-dom';
import { Home, PieChart, Settings, PlusCircle, ArrowRightLeft } from 'lucide-react';
import { cn } from '../lib/utils';

export function Layout() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 pb-20">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-divider px-6 py-4 pb-safe z-[100]">
        <div className="max-w-md mx-auto flex justify-between items-center relative">
          <NavLink
            to="/"
            className={({ isActive }) =>
              cn("flex flex-col items-center gap-1 text-[10px] font-bold transition-all", isActive ? "text-primary-blue" : "text-ink/30")
            }
          >
            <Home className="w-7 h-7" />
            <span>首頁</span>
          </NavLink>
          
          <NavLink
            to="/dashboard"
            className={({ isActive }) =>
              cn("flex flex-col items-center gap-1 text-[10px] font-bold transition-all", isActive ? "text-primary-blue" : "text-ink/30")
            }
          >
            <PieChart className="w-7 h-7" />
            <span>報表</span>
          </NavLink>

          <NavLink
            to="/receipt/new"
            className="flex flex-col items-center gap-1 -mt-12"
          >
            <div className="bg-primary-blue text-white p-5 rounded-full shadow-[0_8px_20px_rgba(155,187,214,0.4)] active:scale-95 transition-all border-4 border-white">
              <PlusCircle className="w-9 h-9" />
            </div>
            <span className="text-[10px] font-bold text-ink/30 mt-1">記帳</span>
          </NavLink>

          <NavLink
            to="/transfer"
            className={({ isActive }) =>
              cn("flex flex-col items-center gap-1 text-[10px] font-bold transition-all", isActive ? "text-primary-blue" : "text-ink/30")
            }
          >
            <ArrowRightLeft className="w-7 h-7" />
            <span>轉帳</span>
          </NavLink>

          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn("flex flex-col items-center gap-1 text-[10px] font-bold transition-all", isActive ? "text-primary-blue" : "text-ink/30")
            }
          >
            <Settings className="w-7 h-7" />
            <span>設定</span>
          </NavLink>
        </div>
      </nav>
    </div>
  );
}
