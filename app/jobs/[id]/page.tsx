"use client";

import { useParams } from "next/navigation";
import JobView from "@/app/components/JobView";

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  return <JobView id={id} />;
}
