import { memo, useEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CodeBlock } from './CodeBlock'
import { LANGUAGES } from './languages'
import { safeLink } from './safeLink'
import './markdown.css'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { languages: LANGUAGES, detect: false }]
]

function LinkButton({ url, children }: { url: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      return
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <button type="button" className="markdown__link" title={url} onClick={() => void copy()}>
        {children}
      </button>
      {copied && (
        <span className="markdown__copied" role="status">
          Copied
        </span>
      )}
    </>
  )
}

const components: Components = {
  a({ href, children }) {
    const url = safeLink(href)
    return url ? <LinkButton url={url}>{children}</LinkButton> : <span>{children}</span>
  },
  img({ alt }) {
    return <span>{alt ?? ''}</span>
  },
  table({ children }) {
    return (
      <div className="markdown__table">
        <table>{children}</table>
      </div>
    )
  },
  pre({ children }) {
    const code = Array.isArray(children) ? children[0] : children
    const className = (code as ReactElement<{ className?: string }> | undefined)?.props?.className
    const language = /language-([\w-]+)/.exec(className ?? '')?.[1]
    return <CodeBlock language={language}>{children}</CodeBlock>
  }
}

// Links are validated in the `a` component, so the default transform is bypassed.
const urlTransform = (url: string) => url

export interface MarkdownProps {
  text: string
}

export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
