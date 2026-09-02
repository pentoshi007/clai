
import { createContext, useContext, type ReactNode } from "react";
import type { AppServices } from "../bootstrap/composition-root.js";
import { themeFor, type Theme } from "../rendering/theme.js";

interface ServicesContextValue {
  readonly services: AppServices;
  readonly theme: Theme;
}

const ServicesContext = createContext<ServicesContextValue | null>(null);

export function ServicesProvider(props: {
  services: AppServices;
  children: ReactNode;
}): ReactNode {
  const value: ServicesContextValue = {
    services: props.services,
    theme: themeFor(props.services.capabilities.themeHint),
  };
  return (
    <ServicesContext.Provider value={value}>
      {props.children}
    </ServicesContext.Provider>
  );
}

export function useServices(): AppServices {
  const ctx = useContext(ServicesContext);
  if (!ctx) throw new Error("useServices must be used within a ServicesProvider");
  return ctx.services;
}

export function useTheme(): Theme {
  const ctx = useContext(ServicesContext);
  if (!ctx) throw new Error("useTheme must be used within a ServicesProvider");
  return ctx.theme;
}
