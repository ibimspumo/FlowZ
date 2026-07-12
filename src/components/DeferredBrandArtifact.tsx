import { useI18n } from '../i18n';
import { RecoverableLazy } from './RecoverableLazy';
const loadView=()=>import('./BrandArtifactView').then((module)=>({default:module.BrandArtifactView}));
export function DeferredBrandArtifact({value}:{value:string}){const{t}=useI18n();return <RecoverableLazy loader={loadView} componentProps={{value}} loading={<div className="panel-loading" role="status">{t('common.loading')}</div>}/>}
