"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SWRConfig } from "swr";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { Toaster, toast } from "@/components/ui/Toast";
import { isAuthed } from "@/lib/auth";

// FE-04: erro de qualquer query SWR vira toast (deduplicado por chave, 1x por minuto)
const lastErrorAt: Record<string, number> = {};
function onSwrError(err: any, key: string) {
  const now = Date.now();
  if (lastErrorAt[key] && now - lastErrorAt[key] < 60_000) return;
  lastErrorAt[key] = now;
  toast.error(err?.message || "Erro ao atualizar dados. Tentando novamente…");
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (!isAuthed()) router.replace("/login");
  }, [router]);

  return (
    <SWRConfig value={{ onError: onSwrError }}>
    <div className="min-h-screen">
      <Sidebar onCmdK={() => setCmdkOpen(true)} />
      <Topbar />
      <main
        className="min-h-screen"
        style={{
          paddingLeft: "var(--sidebar-w)",
          paddingTop: "var(--topbar-h)",
          paddingRight: "24px",
          paddingBottom: "32px"
        }}
      >
        <div className="px-6 py-6">{children}</div>
      </main>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />
      <Toaster />
    </div>
    </SWRConfig>
  );
}
