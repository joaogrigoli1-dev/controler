import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui"],
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"]
      },
      colors: {
        // NOC dark palette
        bg: "hsl(var(--bg))",
        "surface-0": "hsl(var(--surface-0))",
        "surface-1": "hsl(var(--surface-1))",
        "surface-2": "hsl(var(--surface-2))",
        border: "hsl(var(--border))",
        "border-hi": "hsl(var(--border-hi))",
        accent: "hsl(var(--accent))",
        cyan: "hsl(var(--cyan))",
        green: "hsl(var(--green))",
        yellow: "hsl(var(--yellow))",
        red: "hsl(var(--red))",
        orange: "hsl(var(--orange))",
        purple: "hsl(var(--purple))",
        muted: "hsl(var(--muted))",
        text: "hsl(var(--text))"
      },
      borderRadius: {
        // dark-v2 v4: botão/input 8 (md) · menu/item 10 · card/modal 14 (lg)
        lg: "var(--radius-lg)",
        menu: "var(--radius-menu)",
        md: "var(--radius)",
        sm: "var(--radius-sm)"
      },
      keyframes: {
        pulse: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.4" } },
        scanline: { "0%": { transform: "translateY(-100%)" }, "100%": { transform: "translateY(100vh)" } },
        "fade-up": { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "translateY(0)" } }
      },
      animation: {
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        scanline: "scanline 8s linear infinite",
        "fade-up": "fade-up 280ms cubic-bezier(0.32, 0.72, 0, 1)"
      },
      boxShadow: {
        glow: "0 0 32px var(--accent-glow)",
        "glow-sm": "0 0 16px var(--accent-glow)"
      }
    }
  },
  plugins: [require("tailwindcss-animate")]
};

export default config;
