import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#19222f",
        paper: "#f7f9fc",
        moss: "#2d6dc3",
        citron: "#fad13b",
        coral: "#dc4f5f",
        harbor: "#2d6dc3",
        "primary-strong": "#0066ff",
        "primary-light": "#8fb9ff",
        "accent-light": "#faeb75",
        "bg-primary": "#f7f9fc",
        "bg-secondary": "#ffffff",
        "bg-primary-light": "#f0f3f8",
        "bg-primary-deep": "#f3f5fa",
        "bg-sidebar": "#eff1f5",
        "bg-content": "#f8f9fc",
        "text-secondary": "#3f4a5a",
        "text-tertiary": "#8896a6",
        neutral: {
          50: "#f7f9fc",
          100: "#edf1f8",
          200: "#dfe4ed",
          300: "#c5cedb",
          400: "#92a1b7",
          500: "#677487",
          600: "#4f5a6d",
          700: "#3f4a5a",
          800: "#2c3542",
          900: "#19222f",
          950: "#10161f",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "#2d6dc3",
          foreground: "#ffffff",
        },
        secondary: {
          DEFAULT: "#f0f3f8",
          foreground: "#3f4a5a",
        },
        destructive: {
          DEFAULT: "#dc4f5f",
          foreground: "#ffffff",
        },
        muted: {
          DEFAULT: "#edf1f8",
          foreground: "#677487",
        },
        accent: {
          DEFAULT: "#fad13b",
          foreground: "#10161f",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
        chart: {
          "1": "var(--chart-1)",
          "2": "var(--chart-2)",
          "3": "var(--chart-3)",
          "4": "var(--chart-4)",
          "5": "var(--chart-5)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        panel: "0 16px 50px rgb(45 109 195 / 0.10)",
      },
      fontFamily: {
        sans: ["var(--font-body)", "Inter", "system-ui", "sans-serif"],
        display: ["var(--font-brand)", "Instrument Serif", "Georgia", "serif"],
        grotesk: ["var(--font-grotesk)", "Space Grotesk", "Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
