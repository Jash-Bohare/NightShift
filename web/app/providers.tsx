"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { publicEnv } from "../lib/public-env";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 10_000,
          },
        },
      }),
  );

  const app = publicEnv.privyAppId ? (
    <PrivyProvider
      appId={publicEnv.privyAppId}
      config={{
        loginMethods: ["email", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      {children}
    </PrivyProvider>
  ) : (
    children
  );

  return <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>;
}
