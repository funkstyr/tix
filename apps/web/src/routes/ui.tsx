import { type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

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
import { Input } from "@tix/core-ui/input";
import { Label } from "@tix/core-ui/label";
import { Separator } from "@tix/core-ui/separator";

export const Route = createFileRoute("/ui")({
  component: GalleryPage,
});

function GalleryPage(): JSX.Element {
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
    </div>
  );
}
