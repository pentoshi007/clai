/** @jsxImportSource @opentui/react */
/**
 * Dependency-injection providers for the v2 shell (V2-031).
 *
 * The composition root is created once at bootstrap and handed to the tree
 * here; components read services through `useServices` instead of importing
 * singletons, so the same App can be mounted with fakes in a headless renderer.
 */

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
