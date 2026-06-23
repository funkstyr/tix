import { type JSX, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { Alert } from "@tix/core-ui/alert";
import { Badge } from "@tix/core-ui/badge";
import { Button } from "@tix/core-ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@tix/core-ui/card";
import { EmptyState } from "@tix/core-ui/empty-state";
import { Input } from "@tix/core-ui/input";
import { Label } from "@tix/core-ui/label";
import { PageHeader } from "@tix/core-ui/page-header";
import { Separator } from "@tix/core-ui/separator";
import { Spinner } from "@tix/core-ui/spinner";

export const Route = createFileRoute("/ui")({
  component: GalleryPage,
});

function GalleryPage(): JSX.Element {
  const listAction = useMemo(() => <Button>List a ticket</Button>, []);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Buttons</h2>

        <div className="flex flex-wrap items-center gap-3">
          <Button>Default</Button>

          <Button variant="secondary">Secondary</Button>

          <Button variant="destructive">Destructive</Button>

          <Button variant="outline">Outline</Button>

          <Button variant="ghost">Ghost</Button>

          <Button variant="link">Link</Button>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Badges</h2>

        <div className="flex flex-wrap items-center gap-3">
          <Badge>Default</Badge>

          <Badge variant="secondary">Secondary</Badge>

          <Badge variant="destructive">Destructive</Badge>

          <Badge variant="outline">Outline</Badge>

          <Badge variant="success">Success</Badge>
        </div>
      </section>

      <Separator />

      <section className="flex max-w-sm flex-col gap-3">
        <h2 className="text-lg font-semibold">Form</h2>

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>

          <Input id="email" type="email" placeholder="you@example.com" />
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Card</h2>

        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Lower Bowl · Section 102</CardTitle>

            <CardDescription>Two seats together, aisle access.</CardDescription>
          </CardHeader>

          <CardContent>
            <p className="text-sm">Face value plus fees, transferable instantly.</p>
          </CardContent>

          <CardFooter>
            <Button>Reserve</Button>
          </CardFooter>
        </Card>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">PageHeader</h2>

        <PageHeader title="Tickets" description="Browse every listing" action={listAction} />
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Alert &amp; Spinner</h2>

        <Alert>Sold out — no inventory remaining.</Alert>

        <Spinner label="Loading" />
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">EmptyState</h2>

        <EmptyState
          title="No tickets yet"
          description="Be the first to list one."
          action={listAction}
        />
      </section>
    </div>
  );
}
