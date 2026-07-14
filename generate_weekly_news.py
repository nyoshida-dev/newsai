import json
import os
import sys
from datetime import datetime, timedelta
from typing import Dict, List, Any
import argparse
from dotenv import load_dotenv
import re

from config import Config, load_config
from llm_providers import LLMProvider, LLMError, create_provider

load_dotenv()

class WeeklyNewsGenerator:
    def __init__(self, provider: LLMProvider, config: Config, verbose: bool = False):
        self.provider = provider
        self.config = config
        self.verbose = verbose

    def _log(self, message: str) -> None:
        if self.verbose:
            print(message)
        
    def load_messages(self, filename: str) -> List[Dict]:
        try:
            with open(filename, 'r', encoding='utf-8') as f:
                data = json.load(f)
                messages = data.get('messages', [])
                self._log(f"📥 {len(messages)} 件のメッセージを読み込みました")
                return messages
        except FileNotFoundError:
            print("❌ メッセージファイルが見つかりません", file=sys.stderr)
            return []
        except json.JSONDecodeError:
            print("❌ JSONファイルの読み込みエラー", file=sys.stderr)
            return []
    
    def filter_recent_messages(self, messages: List[Dict], days: int = 7) -> List[Dict]:
        cutoff_time = (datetime.now() - timedelta(days=days)).timestamp()
        recent_messages = []
        
        for msg in messages:
            try:
                msg_ts = float(msg.get('ts', 0))
                if msg_ts >= cutoff_time:
                    recent_messages.append(msg)
            except (ValueError, TypeError):
                continue
        
        self._log(f"📅 過去{days}日間のメッセージ: {len(recent_messages)}件")
        return recent_messages
    
    def prepare_messages_for_analysis(self, messages: List[Dict]) -> str:
        """メッセージを分析用に整形"""
        formatted_messages = []
        max_chars = self.config.max_message_chars
        max_per_channel = self.config.max_messages_per_channel
        
        # チャンネルごとにグループ化
        channels = {}
        for msg in messages:
            channel = msg.get('channel_name', 'unknown')
            if channel not in channels:
                channels[channel] = []
            
            # ボットメッセージや添付ファイルのみのメッセージはスキップ
            if msg.get('subtype') in ['bot_message', 'file_share']:
                continue
                
            text = msg.get('text', '').strip()
            if not text or len(text) < 10:  # 短すぎるメッセージはスキップ
                continue
                
            # URL削除
            text = re.sub(r'<https?://[^\s>]+>', '', text)
            text = re.sub(r'https?://[^\s]+', '', text)
            
            # メンション削除
            text = re.sub(r'<@[A-Z0-9]+>', '', text)
            
            # 絵文字削除（簡易版）
            text = re.sub(r':[a-z_]+:', '', text)
            
            # 改行削除
            text = re.sub(r'\n', '', text)
            
            user_name = msg.get('user_name', '')
            channels[channel].append({
                'text': text[:max_chars],
                'user_name': user_name
            })
        
        for channel, msgs in channels.items():
            if msgs:
                formatted_messages.append(f"\n#チャンネル：【#{channel}】")
                for msg in msgs[-max_per_channel:]:
                    user_part = f"[{msg['user_name']}] " if msg.get('user_name') else ""
                    formatted_messages.append(f"- {user_part}{msg['text']}")
        
        return "\n".join(formatted_messages)

    def generate_news_summary(self, messages_text: str) -> str:
        self._log("🤖 LLMで分析中...")
        
        try:
            if self.config.instruction_file:
                with open(self.config.instruction_file, "r", encoding="utf-8") as f:
                    instruction = f.read()
            else:
                instruction = self.config.instruction_prompt

            summary = self.provider.generate(
                self.config.system_prompt,
                instruction + "\n" + messages_text,
            )
            self._log("✅ ニュースサマリー生成完了")
            return summary
            
        except LLMError as e:
            print(f"❌ LLMエラー: {e}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"❌ LLMエラー: {str(e)}", file=sys.stderr)
            return None
    

    
    def generate_news_text(self, messages_file: str = None, days: int = 7, messages: List[Dict] = None) -> str:
        self._log(f"\n{'='*60}")
        self._log(f"📰 週次ニュース生成を開始")
        self._log(f"{'='*60}\n")
        
        if messages is None:
            if not messages_file:
                print("❌ メッセージソースが指定されていません", file=sys.stderr)
                return None
            messages = self.load_messages(messages_file)
            if not messages:
                print("❌ メッセージが読み込めませんでした", file=sys.stderr)
                return None
        
        recent_messages = self.filter_recent_messages(messages, days)
        if not recent_messages:
            print("❌ 対象期間のメッセージがありません", file=sys.stderr)
            return None
        
        formatted_text = self.prepare_messages_for_analysis(recent_messages)
        if not formatted_text:
            print("❌ 分析可能なメッセージがありません", file=sys.stderr)
            return None
        
        self._log(f"📝 分析対象: {len(formatted_text)} 文字")
        
        summary = self.generate_news_summary(formatted_text)
        if not summary:
            print("❌ ニュースサマリーの生成に失敗しました", file=sys.stderr)
            return None
        
        self._log("\n" + "="*60)
        self._log("📋 ニュースサマリー生成完了")
        self._log("="*60 + "\n")
        
        return summary

def main():
    parser = argparse.ArgumentParser(
        description='週次社内ニュース生成ツール',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用例:
  python generate_weekly_news.py
  python generate_weekly_news.py --days 7
  python generate_weekly_news.py --messages-file slack_messages_20250928.json
  python generate_weekly_news.py --provider claude --model sonnet
  python generate_weekly_news.py -v  # 詳細ログを表示
        """
    )
    
    parser.add_argument('--messages-file', type=str, help='メッセージファイルのパス（デフォルト: 最新のslack_messages_*.json）')
    parser.add_argument('--days', type=int, default=None, help='分析対象の日数（デフォルト: config.toml）')
    parser.add_argument('--openai-key', type=str, help='OpenAI APIキー（非推奨: provider=api を強制）')
    parser.add_argument('--provider', type=str, help='LLMプロバイダ (api|codex|claude|opencode)')
    parser.add_argument('--model', type=str, help='モデル名')
    parser.add_argument('--config', type=str, help='config.toml のパス')
    parser.add_argument('-v', '--verbose', action='store_true', help='詳細なログを出力する')
    
    args = parser.parse_args()

    cfg = load_config(args.config)
    if args.provider:
        cfg.provider = args.provider
    if args.model is not None:
        cfg.model = args.model
    if args.days is not None:
        cfg.days = args.days

    # Deprecated: --openai-key forces provider=api and injects the key
    if args.openai_key:
        cfg.provider = "api"
        os.environ[cfg.api_key_env] = args.openai_key

    if cfg.provider == "api":
        if not os.environ.get(cfg.api_key_env):
            print(f"❌ エラー: {cfg.api_key_env} が設定されていません", file=sys.stderr)
            print("\n環境変数を設定してください:", file=sys.stderr)
            print(f"export {cfg.api_key_env}='sk-...'", file=sys.stderr)
            return 1
    
    if not args.messages_file:
        import glob
        json_files = glob.glob("slack_messages_*.json")
        if json_files:
            args.messages_file = sorted(json_files)[-1]
            if args.verbose:
                print(f"📁 メッセージファイルを検出")
        else:
            print("❌ slack_messages_*.json ファイルが見つかりません", file=sys.stderr)
            print("先に collect_slack_messages.py を実行してください", file=sys.stderr)
            return 1
    
    try:
        provider = create_provider(cfg)
    except LLMError as e:
        print(str(e), file=sys.stderr)
        return 1

    generator = WeeklyNewsGenerator(provider, cfg, verbose=args.verbose)
    
    try:
        news_text = generator.generate_news_text(
            messages_file=args.messages_file,
            days=cfg.days
        )
        
        if news_text:
            print(news_text)
            if args.verbose:
                print("✅ ニューステキストの生成が完了しました")
            return 0
        else:
            print("❌ ニューステキストの生成に失敗しました", file=sys.stderr)
            return 1
            
    except Exception as e:
        print(f"❌ 予期しないエラー: {str(e)}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    exit(main())
