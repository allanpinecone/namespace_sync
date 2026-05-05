'use client';

import { cn } from '@/lib/cn';
import type { ButtonHTMLAttributes, InputHTMLAttributes, HTMLAttributes } from 'react';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn('rounded-xl border border-border bg-card p-5 shadow-sm', className)}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('mb-4 text-lg font-semibold tracking-tight', className)} {...props} />;
}

export function Button({
  className,
  variant = 'primary',
  size = 'md',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'outline' | 'success' | 'warning';
  size?: 'sm' | 'md' | 'lg';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50';
  const sizes = {
    sm: 'h-8 px-3 text-sm',
    md: 'h-10 px-4 text-sm',
    lg: 'h-12 px-6 text-base',
  };
  const variants = {
    primary: 'bg-primary text-primary-foreground hover:opacity-90',
    ghost: 'bg-transparent hover:bg-muted',
    danger: 'bg-danger text-white hover:opacity-90',
    outline: 'border border-border bg-transparent hover:bg-muted',
    success: 'bg-success text-white hover:opacity-90',
    warning: 'bg-warning text-black hover:opacity-90',
  };
  return (
    <button type={type} className={cn(base, sizes[size], variants[variant], className)} {...props} />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'h-10 w-full rounded-md border border-border bg-card px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50',
        className,
      )}
    />
  );
}

export function Pill({
  children,
  tone = 'default',
  className,
}: {
  children: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}) {
  const tones = {
    default: 'bg-muted text-foreground',
    success: 'bg-success/20 text-success',
    warning: 'bg-warning/20 text-warning',
    danger: 'bg-danger/20 text-danger',
    info: 'bg-primary/20 text-primary',
  };
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
