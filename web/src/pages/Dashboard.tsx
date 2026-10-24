import { t } from '../i18n';
import { ThemeStatusCard, useThemeStatus } from './ThemeStatusCard';

// Dashboard. Scaffold: app embed status only; the setup checklist and 30-day counts come with the admin UI step.

export function Dashboard() {
  const theme = useThemeStatus();
  return (
    <s-page heading={t('dashboard.heading')}>
      <ThemeStatusCard state={theme.state} onRecheck={theme.recheck} />
    </s-page>
  );
}
