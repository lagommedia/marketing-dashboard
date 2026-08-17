import AiAnalystChat from "@/components/dashboard/AiAnalystChat";

export default function AiAnalystPage() {
  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">AI Company Analyst</h1>
        <p className="text-sm text-gray-500 mt-1">
          Ask anything about your marketing performance — spend, pipeline, CAC, LTV, funnel conversion, organic search, and company classification. Data is pulled live from your dashboard.
        </p>
      </div>
      <AiAnalystChat />
    </div>
  );
}
