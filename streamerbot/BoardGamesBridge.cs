// Twitch Board Games — Streamer.bot bridge action
// ------------------------------------------------
// Paste this whole file into an "Execute C# Code" sub-action of an action named
//   BoardGames · Bridge
// (no trigger needed — the overlay runs it over the WebSocket server).
//
// The overlay passes an `op` argument plus op-specific arguments:
//   op = chat              message
//   op = whisper           user, message
//   op = predictionCreate  title, outcomes ("a|b|c", 2–10), seconds
//   op = predictionLock
//   op = predictionCancel
// Resolving is done by the second action, "BoardGames · Resolve", using the
// built-in "Resolve Last Prediction" sub-action (see docs/STREAMERBOT.md).

using System;
using System.Collections.Generic;
// No System.Linq on purpose: Streamer.bot doesn't reference System.Core by default.

public class CPHInline
{
    public bool Execute()
    {
        string op = Arg("op");
        switch (op)
        {
            case "chat":
                CPH.SendMessage(Arg("message"), true);
                break;

            case "whisper":
                CPH.SendWhisper(Arg("user"), Arg("message"), true);
                break;

            case "predictionCreate":
            {
                List<string> outcomes = new List<string>();
                foreach (string part in Arg("outcomes").Split('|'))
                {
                    string title = part.Trim();
                    if (title.Length > 0 && outcomes.Count < 10) outcomes.Add(title);
                }
                if (outcomes.Count < 2)
                {
                    CPH.LogWarn("[BoardGames] prediction needs at least 2 outcomes");
                    return false;
                }
                int seconds;
                if (!int.TryParse(Arg("seconds"), out seconds)) seconds = 60;
                seconds = Math.Max(30, Math.Min(1800, seconds));
                string id = CPH.TwitchPredictionCreate(Arg("title"), outcomes, seconds);
                CPH.SetGlobalVar("boardGamesPredictionId", id ?? "", false);
                break;
            }

            case "predictionLock":
                if (PredictionId() != "") CPH.TwitchPredictionLock(PredictionId());
                break;

            case "predictionCancel":
                if (PredictionId() != "") CPH.TwitchPredictionCancel(PredictionId());
                CPH.SetGlobalVar("boardGamesPredictionId", "", false);
                break;

            default:
                CPH.LogWarn("[BoardGames] unknown op '" + op + "'");
                return false;
        }
        return true;
    }

    // Arguments from the WebSocket can arrive as strings or numbers — read everything as text.
    private string Arg(string key)
    {
        object value;
        return CPH.TryGetArg(key, out value) && value != null ? value.ToString() : "";
    }

    private string PredictionId()
    {
        return CPH.GetGlobalVar<string>("boardGamesPredictionId", false) ?? "";
    }
}
