import type { ReactNode } from 'react';
import { Icon } from '../../icons/Icon';
import type { IconName } from '../../icons/registry';
import '../shared-ui.css';

export function EmptyState({ icon = 'info', title, description, action }: { icon?: IconName; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="cwEmptyState">
      <div className="cwEmptyStateIcon"><Icon name={icon} size="lg" tone="muted" decorative /></div>
      <div className="cwEmptyStateTitle">{title}</div>
      {description ? <div className="cwEmptyStateDesc">{description}</div> : null}
      {action ? <div className="cwEmptyStateAction">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = '불러오는 중' }: { label?: string }) {
  return <Icon className="cwSpin" name="loader" ariaLabel={label} />;
}
