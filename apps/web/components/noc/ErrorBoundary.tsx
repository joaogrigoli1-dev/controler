"use client";
import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

interface State {
  error: Error | null;
}

/**
 * ErrorBoundary — gate UX da FASE 4: erro de render em uma tela nunca derruba
 * o shell do NOC inteiro. Fallback com retry (reset de estado).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[noc] erro de render capturado pelo ErrorBoundary:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="glass-card p-8 m-6 text-center space-y-3">
          <AlertTriangle size={28} className="mx-auto text-red" />
          <p className="text-sm text-white/80">Esta tela encontrou um erro inesperado.</p>
          <p className="text-xs text-white/60 text-mono">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })} className="btn btn-primary mx-auto">
            <RefreshCcw size={12} /> Recarregar tela
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
