import { FileQuestion, MousePointerClick } from "lucide-react";

export function EmptyStateNoHistory() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <FileQuestion size={32} />
      </div>
      <p className="empty-state__title">No export history yet</p>
      <p className="empty-state__hint">Run your first export to see results here.</p>
    </div>
  );
}

export function EmptyStateSelectTenant() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <MousePointerClick size={32} />
      </div>
      <p className="empty-state__title">No tenant selected</p>
      <p className="empty-state__hint">Select a tenant above to view its export history.</p>
    </div>
  );
}
