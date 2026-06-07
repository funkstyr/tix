import { type JSX, type ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@tix/core-ui/card";

export type AuthCardProps = {
  title: string;
  children: ReactNode;
};

export function AuthCard({ title, children }: AuthCardProps): JSX.Element {
  return (
    <section className="mx-auto max-w-sm py-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{title}</CardTitle>
        </CardHeader>

        <CardContent>{children}</CardContent>
      </Card>
    </section>
  );
}
