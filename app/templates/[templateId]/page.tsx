import { notFound } from "next/navigation";

import { TemplateEditor } from "@/components/template-editor";
import { isCompositionTemplateId } from "@/lib/composition-templates";

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;
  if (!isCompositionTemplateId(templateId)) notFound();
  return <TemplateEditor templateId={templateId} />;
}
