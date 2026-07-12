import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import { RecoverableLazy } from './RecoverableLazy';
import type { FontSelection } from './FontPicker';

const loadFontPicker=()=>import('./FontPicker').then((module)=>({default:module.FontPicker}));

type Props={label:string;value:string;variantIndex?:number;axes?:Record<string,number>;onChange:(selection:FontSelection)=>void};

export function DeferredFontPicker(props:Props){
  const{t}=useI18n();
  const[requested,setRequested]=useState(false);
  if(!requested)return <button type="button" className="font-picker-trigger nodrag nowheel nopan" aria-label={props.label} aria-haspopup="listbox" aria-expanded="false" onClick={()=>setRequested(true)}><span><strong>{props.value}</strong><small>{t('font.openCatalog')}</small></span><ChevronDown size={13}/></button>;
  return <RecoverableLazy loader={loadFontPicker} componentProps={{...props,initiallyOpen:true}} className="font-picker-trigger font-picker-loading" loading={<div className="font-picker-trigger font-picker-loading" role="status" aria-live="polite"><span><strong>{props.value}</strong><small>{t('common.loading')}</small></span><LoaderCircle className="spin" size={13}/></div>}/>;
}
