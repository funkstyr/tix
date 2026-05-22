import { type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home(): JSX.Element {
  return <h1>tix</h1>;
}
