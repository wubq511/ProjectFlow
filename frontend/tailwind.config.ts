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
        // my-saas brand tokens
        brand: {
          DEFAULT: "#2d6dc3",
          strong: "#0066ff",
          light: "#8fb9ff",
        },
        accent: {
          DEFAULT: "#fad13b",
          light: "#faeb75",
        },
        surface: {
          primary: "#fdfaf5",
          secondary: "#ffffff",
          "primary-dark": "#0b1220",
          "secondary-dark": "#0f1b2d",
        },
        ink: {
          primary: "#2d6dc3",
          secondary: "#3f4a5a",
          tertiary: "#7a6550",
        },
        // Legacy aliases (preserve backward compat)
        moss: "#2d6dc3",
        paper: "#fdfaf5",
        citron: "#fad13b",
        coral: "#dc6a4d",
        harbor: "#2d6dc3",
        // shadcn/ui CSS variable mappings
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
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
        panel: "0 16px 50px rgba(31, 41, 51, 0.12)",
        card: "0 1px 2px rgba(0,0,0,0.05)",
        "card-hover": "0 4px 6px -1px rgba(0,0,0,0.05)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        brand: ["var(--font-brand)", "Instrument Serif", "Georgia", "serif"],
        display: ["var(--font-display)", "Instrument Serif", "Georgia", "serif"],
      },
      maxWidth: {
        screen: "1200px",
        inner: "800px",
      },
    },
  },
  plugins: [],
};

export default config;
