import { t } from '../i18n';
import { navigate } from '../router';

/** 404 page. */
export function NotFound() {
  return (
    <s-page heading={t('common.notFoundHeading')}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>{t('common.notFoundBody')}</s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" onClick={() => navigate('/')}>
              {t('common.goHome')}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
