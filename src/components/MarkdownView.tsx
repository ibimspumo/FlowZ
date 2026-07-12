import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownView({value}:{value:string}){
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a:({node:_,...props})=><a {...props} target="_blank" rel="noreferrer"/>}}>{value}</ReactMarkdown>;
}
