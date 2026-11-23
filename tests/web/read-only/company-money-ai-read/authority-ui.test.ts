// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { mount } from './harness.js';
import { FEATURE, failed, reply } from './fixtures.js';
it.each(['report', 'feature', 'sources', 'models'] as const)('a failed %s refresh removes its action controls while retaining display facts', async area => {
 let bad = false;
 const path = area === 'report' ? '/app/admin/money/report' : area === 'feature' ? `/app/admin/money/report/features/${FEATURE}` : '/app/admin/ai-spending';
 const button = area === 'report' ? 'New feature' : area === 'feature' ? 'Rename' : 'Save learning model';
 const f = mount(path, async r => bad && (area === 'report' ? r.path.includes('/org/report') : area === 'feature' ? r.path.includes('/report/features/') : area === 'sources' ? r.path.includes('/model-sources') : r.path.includes('/agent-models')) ? failed : reply(r));
 // LAYOUT-COUPLED: the model and learning saves are in the "Change a model" dialog opened from the section header.
 if (area === 'models' || area === 'sources') fireEvent.click(await screen.findByRole('button', { name: 'Change a model' }));
 await screen.findByRole('button', { name: button }); bad = true;
 await act(async () => { await f.client.refetchQueries(); });
 await waitFor(() => expect(screen.queryByRole('button', { name: button })).toBeNull());
 expect(f.requests.every(r => r.method === 'GET')).toBe(true);
});
// LAYOUT-COUPLED: the free-text Project field and its Open button are gone (each project has its own row). The one remaining way to name a project is the
// ?project= link from the eval card; a name the page would not accept itself opens no editor and sends no read for it.
it.each(['Bad Name', '../private', 'x/y'])('the ?project= link refuses %s; the Project field is there, empty', async typed => {
 const f = mount('/app/admin/product-ai?project=' + encodeURIComponent(typed)); await screen.findByText('Key connected');
 expect(screen.getByLabelText<HTMLInputElement>('Project').value).toBe(''); expect(screen.getByRole('button', { name: 'Open' })).toHaveProperty('disabled', true);
 await act(async () => { await Promise.resolve(); });
 expect(screen.queryByLabelText('AI provider')).toBeNull();
 expect(f.requests.filter(r => r.path.includes('/product-ai')).map(r => r.path)).toEqual(['/v1/app/projects/web/product-ai']);
});
