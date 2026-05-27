"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { isAuthed } from "@/lib/auth";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (!isAuthed()) router.replace("/login");
  }, [router]);

  return (
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
    </div>
  );
}
