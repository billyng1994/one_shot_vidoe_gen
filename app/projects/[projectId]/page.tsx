import { Studio } from "@/components/studio";
import { isProjectId } from "@/lib/studio-projects";
import { notFound } from "next/navigation";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  return <Studio initialProjectId={projectId} />;
}
