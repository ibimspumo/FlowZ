import { useI18n } from '../i18n';
import { RecoverableLazy } from './RecoverableLazy';
const loadMarkdown=()=>import('./MarkdownView').then((module)=>({default:module.MarkdownView}));
export function DeferredMarkdown({value}:{value:string}){const{t}=useI18n();return <RecoverableLazy loader={loadMarkdown} componentProps={{value}} className="markdown-lazy" loading={<span className="markdown-loading" role="status" aria-label={t('common.loading')}/>}/>}
