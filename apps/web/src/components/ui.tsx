import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

export function Button({ className = '', variant = 'default', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`card ${className}`} {...props} />;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}

export function CodeBlock({ children }: { children: ReactNode }) {
  return <pre className="code-block"><code>{children}</code></pre>;
}
